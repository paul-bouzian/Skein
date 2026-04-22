export function normalizeVersion(input) {
  return input.startsWith("v") ? input.slice(1) : input;
}

export function validateVersion(candidate) {
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(candidate)) {
    throw new Error(`Invalid release version: ${candidate}`);
  }
}
