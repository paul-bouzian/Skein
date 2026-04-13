import { VOICE_PROCESSOR_NAME } from "../../../lib/app-identity";

const TARGET_SAMPLE_RATE_HZ = 24_000;
const TARGET_BITS_PER_SAMPLE = 16;
export const MAX_RECORDING_DURATION_MS = 120_000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4_096;

type EncodedVoiceClip = {
  audioBase64: string;
  durationMs: number;
  mimeType: "audio/wav";
  sampleRateHz: typeof TARGET_SAMPLE_RATE_HZ;
};

type VoiceCapture = {
  cancel: () => Promise<void>;
  stop: () => Promise<EncodedVoiceClip>;
};

type CollectorNode = AudioWorkletNode | ScriptProcessorNode;

type AudioWindowWithWebkit = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export async function startVoiceCapture(): Promise<VoiceCapture> {
  const AudioContextCtor =
    window.AudioContext ?? (window as AudioWindowWithWebkit).webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
    throw new Error(
      "Microphone capture is not available in this desktop runtime.",
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContextCtor();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const silenceGain = audioContext.createGain();
  silenceGain.gain.value = 0;
  source.connect(silenceGain);
  silenceGain.connect(audioContext.destination);

  const chunks: Float32Array[] = [];
  const collector = await createCollectorNode(audioContext, chunks);
  source.connect(collector);
  collector.connect(silenceGain);

  let closed = false;

  async function cleanup() {
    if (closed) {
      return;
    }
    closed = true;

    try {
      collector.disconnect();
    } catch {
      // noop
    }
    try {
      silenceGain.disconnect();
    } catch {
      // noop
    }
    try {
      source.disconnect();
    } catch {
      // noop
    }

    for (const track of stream.getTracks()) {
      track.stop();
    }

    if (audioContext.state !== "closed") {
      try {
        await audioContext.close();
      } catch {
        // Ignore close failures during teardown.
      }
    }
  }

  return {
    cancel: cleanup,
    stop: async () => {
      try {
        const combinedSamples = combineChunks(chunks);
        const limitedSamples = clampSamplesToMaxDuration(
          combinedSamples,
          audioContext.sampleRate,
        );
        const durationMs = durationMsForSampleCount(
          limitedSamples.length,
          audioContext.sampleRate,
        );
        if (durationMs === 0) {
          throw new Error("No speech was detected in the recording.");
        }
        const resampledSamples =
          audioContext.sampleRate === TARGET_SAMPLE_RATE_HZ
            ? limitedSamples
            : resampleLinear(
                limitedSamples,
                audioContext.sampleRate,
                TARGET_SAMPLE_RATE_HZ,
              );
        const wavBytes = encodeMonoPcmWav(
          resampledSamples,
          TARGET_SAMPLE_RATE_HZ,
        );
        const audioBase64 = await bytesToBase64(wavBytes);

        return {
          audioBase64,
          durationMs,
          mimeType: "audio/wav",
          sampleRateHz: TARGET_SAMPLE_RATE_HZ,
        };
      } finally {
        await cleanup();
      }
    },
  };
}

async function createCollectorNode(
  audioContext: AudioContext,
  chunks: Float32Array[],
): Promise<CollectorNode> {
  if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    const processorNameLiteral = JSON.stringify(VOICE_PROCESSOR_NAME);
    const moduleUrl = URL.createObjectURL(
      new Blob(
        [
          `
          class SkeinVoiceProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const channels = inputs[0];
              if (channels && channels.length > 0) {
                const sampleCount = channels[0].length;
                const mono = new Float32Array(sampleCount);
                for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
                  const channel = channels[channelIndex];
                  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
                    mono[sampleIndex] += channel[sampleIndex] / channels.length;
                  }
                }
                this.port.postMessage(mono, [mono.buffer]);
              }
              return true;
            }
          }
          registerProcessor(${processorNameLiteral}, SkeinVoiceProcessor);
        `,
        ],
        { type: "application/javascript" },
      ),
    );

    try {
      await audioContext.audioWorklet.addModule(moduleUrl);
      const workletNode = new AudioWorkletNode(
        audioContext,
        VOICE_PROCESSOR_NAME,
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        },
      );
      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        chunks.push(new Float32Array(event.data));
      };
      return workletNode;
    } catch {
      // Fall back to ScriptProcessorNode on runtimes that do not support AudioWorklet well.
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }

  const processor = audioContext.createScriptProcessor(
    SCRIPT_PROCESSOR_BUFFER_SIZE,
    1,
    1,
  );
  processor.onaudioprocess = (event) => {
    const inputBuffer = event.inputBuffer;
    const channelCount = inputBuffer.numberOfChannels;
    const sampleCount = inputBuffer.length;
    const mono = new Float32Array(sampleCount);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = inputBuffer.getChannelData(channelIndex);
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        mono[sampleIndex] += channel[sampleIndex] / channelCount;
      }
    }
    chunks.push(mono);
  };
  return processor;
}

function clampSamplesToMaxDuration(
  samples: Float32Array,
  sampleRateHz: number,
) {
  const maxSampleCount = Math.max(
    1,
    Math.floor((MAX_RECORDING_DURATION_MS / 1000) * sampleRateHz),
  );
  return samples.length <= maxSampleCount
    ? samples
    : samples.subarray(0, maxSampleCount);
}

function combineChunks(chunks: Float32Array[]) {
  const totalSamples = chunks.reduce((count, chunk) => count + chunk.length, 0);
  const combined = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function durationMsForSampleCount(sampleCount: number, sampleRateHz: number) {
  if (sampleCount === 0) {
    return 0;
  }
  return Math.round((sampleCount / sampleRateHz) * 1000);
}

function resampleLinear(
  input: Float32Array,
  inputSampleRateHz: number,
  targetSampleRateHz: number,
) {
  if (input.length === 0 || inputSampleRateHz === targetSampleRateHz) {
    return input;
  }

  const ratio = inputSampleRateHz / targetSampleRateHz;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(lowerIndex + 1, input.length - 1);
    const weight = position - lowerIndex;
    output[index] =
      input[lowerIndex] * (1 - weight) + input[upperIndex] * weight;
  }
  return output;
}

function encodeMonoPcmWav(samples: Float32Array, sampleRateHz: number) {
  const bytesPerSample = TARGET_BITS_PER_SAMPLE / 8;
  const blockAlign = bytesPerSample * 1;
  const byteRate = sampleRateHz * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, TARGET_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(value), true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

async function bytesToBase64(bytes: Uint8Array) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to encode the recorded audio."));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => {
      reject(new Error("Failed to encode the recorded audio."));
    };
    reader.readAsDataURL(new Blob([bytes], { type: "audio/wav" }));
  });

  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}
