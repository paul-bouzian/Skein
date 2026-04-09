import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ApprovalResponseInput,
  ConversationInteraction,
  PendingApprovalRequest,
  PendingUserInputQuestion,
} from "../../lib/types";
import { ConversationLinkedText } from "./ConversationLinkedText";

type Props = {
  interaction: ConversationInteraction | null;
  queueCount: number;
  submitShortcutKey: number;
  onRespondApproval: (response: ApprovalResponseInput) => Promise<void>;
  onSubmitAnswers: (answers: Record<string, string[]>) => Promise<void>;
};

export function ConversationInteractionPanel({
  interaction,
  queueCount,
  submitShortcutKey,
  onRespondApproval,
  onSubmitAnswers,
}: Props) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const latestSubmitShortcutKeyRef = useRef(submitShortcutKey);
  const lastSubmitShortcutKeyRef = useRef(0);

  useEffect(() => {
    latestSubmitShortcutKeyRef.current = submitShortcutKey;
  }, [submitShortcutKey]);

  useEffect(() => {
    setQuestionIndex(0);
    setSelectedOptions({});
    setFreeText({});
    setSubmitting(false);
    lastSubmitShortcutKeyRef.current = latestSubmitShortcutKeyRef.current;
  }, [interaction?.id]);

  const currentQuestion =
    interaction?.kind === "userInput"
      ? interaction.questions[questionIndex] ?? null
      : null;

  const canContinueQuestion =
    currentQuestion != null && questionHasAnswer(currentQuestion, selectedOptions, freeText);
  const allQuestionsAnswered =
    interaction?.kind === "userInput"
      ? interaction.questions.every((question) =>
          questionHasAnswer(question, selectedOptions, freeText),
        )
      : false;

  useEffect(() => {
    if (submitShortcutKey === lastSubmitShortcutKeyRef.current) {
      return;
    }
    lastSubmitShortcutKeyRef.current = submitShortcutKey;
    if (
      submitShortcutKey === 0 ||
      interaction?.kind !== "userInput" ||
      !allQuestionsAnswered ||
      submitting
    ) {
      return;
    }
    void submitAnswers({
      answers: buildUserInputAnswers(interaction.questions, selectedOptions, freeText),
      onSubmitAnswers,
      setSubmitting,
    });
  }, [
    allQuestionsAnswered,
    freeText,
    interaction,
    onSubmitAnswers,
    selectedOptions,
    submitShortcutKey,
    submitting,
  ]);

  const queueLabel =
    queueCount > 1 ? `Request 1 of ${queueCount}` : "Request requiring attention";

  const requestTitle = useMemo(() => {
    if (!interaction) return "";
    if (interaction.kind === "userInput") return "Codex needs input";
    if (interaction.kind === "approval") return interaction.title;
    return interaction.title;
  }, [interaction]);

  if (!interaction) return null;

  return (
    <section className="tx-interaction">
      <div className="tx-interaction__header">
        <div>
          <span className="tx-item__header">{queueLabel}</span>
          <h3 className="tx-interaction__title">{requestTitle}</h3>
        </div>
        {interaction.kind === "userInput" ? (
          <span className="tx-pill tx-pill--neutral">
            Question {questionIndex + 1} / {interaction.questions.length}
          </span>
        ) : null}
      </div>
      {interaction.kind === "userInput" ? (
        <form
          className="tx-interaction__body"
          onSubmit={(event) => {
            event.preventDefault();
            if (!allQuestionsAnswered || submitting) return;
            void submitAnswers({
              answers: buildUserInputAnswers(interaction.questions, selectedOptions, freeText),
              onSubmitAnswers,
              setSubmitting,
            });
          }}
        >
          {currentQuestion ? (
            <>
              <div className="tx-interaction__question">
                <span className="tx-interaction__question-header">{currentQuestion.header}</span>
                <ConversationLinkedText
                  as="p"
                  className="tx-interaction__question-text"
                  text={currentQuestion.question}
                />
              </div>
              <div className="tx-interaction__option-list">
                {currentQuestion.options.map((option) => {
                  const isSelected = selectedOptions[currentQuestion.id] === option.label;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`tx-interaction__option ${isSelected ? "tx-interaction__option--selected" : ""}`}
                      onClick={() =>
                        setSelectedOptions((state) => ({
                          ...state,
                          [currentQuestion.id]: option.label,
                        }))
                      }
                    >
                      <span className="tx-interaction__option-label">{option.label}</span>
                      <span className="tx-interaction__option-description">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
              {shouldRenderFreeText(currentQuestion) ? (
                <input
                  className="tx-interaction__input"
                  type={currentQuestion.isSecret ? "password" : "text"}
                  placeholder="Or write a custom answer"
                  value={freeText[currentQuestion.id] ?? ""}
                  onChange={(event) =>
                    setFreeText((state) => ({
                      ...state,
                      [currentQuestion.id]: event.target.value,
                    }))
                  }
                />
              ) : null}
            </>
          ) : null}
          <div className="tx-interaction__actions">
            <button
              type="button"
              className="tx-button tx-button--secondary"
              disabled={questionIndex === 0 || submitting}
              onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
            >
              Previous
            </button>
            {interaction.questions.length > 1 && questionIndex < interaction.questions.length - 1 ? (
              <button
                type="button"
                className="tx-button"
                disabled={!canContinueQuestion || submitting}
                onClick={() =>
                  setQuestionIndex((index) =>
                    Math.min(interaction.questions.length - 1, index + 1),
                  )
                }
              >
                Next
              </button>
            ) : (
              <button type="submit" className="tx-button" disabled={!allQuestionsAnswered || submitting}>
                Submit answers
              </button>
            )}
          </div>
        </form>
      ) : interaction.kind === "approval" ? (
        <ApprovalPanel
          request={interaction}
          submitting={submitting}
          onSubmit={async (response) => {
            setSubmitting(true);
            try {
              await onRespondApproval(response);
            } finally {
              setSubmitting(false);
            }
          }}
        />
      ) : (
        <div className="tx-interaction__body">
          <ConversationLinkedText
            as="p"
            className="tx-banner__body"
            text={interaction.message}
          />
        </div>
      )}
    </section>
  );
}

function ApprovalPanel({
  request,
  submitting,
  onSubmit,
}: {
  request: PendingApprovalRequest;
  submitting: boolean;
  onSubmit: (response: ApprovalResponseInput) => Promise<void>;
}) {
  const permissionLines = formatPermissionLines(request);

  return (
    <div className="tx-interaction__body">
      {request.summary ? (
        <ConversationLinkedText
          as="p"
          className="tx-interaction__summary"
          text={request.summary}
        />
      ) : null}
      {request.reason ? (
        <ConversationLinkedText
          as="p"
          className="tx-interaction__reason"
          text={request.reason}
        />
      ) : null}
      {request.command ? <pre className="tx-item__body tx-item__body--tool">{request.command}</pre> : null}
      {request.cwd ? (
        <div className="tx-interaction__detail">
          <span>Working directory</span>
          <code>{request.cwd}</code>
        </div>
      ) : null}
      {request.grantRoot ? (
        <div className="tx-interaction__detail">
          <span>Grant root</span>
          <code>{request.grantRoot}</code>
        </div>
      ) : null}
      {permissionLines.length > 0 ? (
        <div className="tx-interaction__detail-list">
          {permissionLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : null}
      {request.networkContext ? (
        <div className="tx-interaction__detail-list">
          <span>Host: {request.networkContext.host}</span>
          <span>Protocol: {request.networkContext.protocol}</span>
        </div>
      ) : null}
      <div className="tx-interaction__actions tx-interaction__actions--wrap">
        {request.approvalKind === "permissions" ? (
          <>
            <button
              type="button"
              className="tx-button"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: "permissions",
                  decision: "approve",
                  permissions: request.permissions,
                  scope: "turn",
                })
              }
            >
              Approve for turn
            </button>
            <button
              type="button"
              className="tx-button tx-button--secondary"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: "permissions",
                  decision: "approve",
                  permissions: request.permissions,
                  scope: "session",
                })
              }
            >
              Approve for session
            </button>
            <button
              type="button"
              className="tx-button tx-button--ghost"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: "permissions",
                  decision: "decline",
                })
              }
            >
              Decline
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="tx-button"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: request.approvalKind,
                  decision: "accept",
                } as ApprovalResponseInput)
              }
            >
              Approve
            </button>
            <button
              type="button"
              className="tx-button tx-button--secondary"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: request.approvalKind,
                  decision: "acceptForSession",
                } as ApprovalResponseInput)
              }
            >
              Approve for session
            </button>
            <button
              type="button"
              className="tx-button tx-button--ghost"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: request.approvalKind,
                  decision: "decline",
                } as ApprovalResponseInput)
              }
            >
              Decline
            </button>
            <button
              type="button"
              className="tx-button tx-button--ghost"
              disabled={submitting}
              onClick={() =>
                void onSubmit({
                  kind: request.approvalKind,
                  decision: "cancel",
                } as ApprovalResponseInput)
              }
            >
              Cancel turn
            </button>
          </>
        )}
        {request.approvalKind === "commandExecution" &&
        request.proposedExecpolicyAmendment.length > 0 ? (
          <button
            type="button"
            className="tx-button tx-button--secondary"
            disabled={submitting}
            onClick={() =>
              void onSubmit({
                kind: "commandExecution",
                decision: "acceptWithExecpolicyAmendment",
                execpolicyAmendment: request.proposedExecpolicyAmendment,
              })
            }
          >
            Allow similar commands
          </button>
        ) : null}
        {request.approvalKind === "commandExecution"
          ? request.proposedNetworkPolicyAmendments.map((amendment) => (
              <button
                key={`${amendment.action}-${amendment.host}`}
                type="button"
                className="tx-button tx-button--secondary"
                disabled={submitting}
                onClick={() =>
                  void onSubmit({
                    kind: "commandExecution",
                    decision: "applyNetworkPolicyAmendment",
                    networkPolicyAmendment: amendment,
                  })
                }
              >
                {amendment.action === "allow" ? "Allow" : "Deny"} {amendment.host}
              </button>
            ))
          : null}
      </div>
    </div>
  );
}

function buildUserInputAnswers(
  questions: PendingUserInputQuestion[],
  selectedOptions: Record<string, string>,
  freeText: Record<string, string>,
) {
  return Object.fromEntries(
    questions.map((question) => {
      const answers = [];
      const selected = selectedOptions[question.id];
      const custom = freeText[question.id]?.trim();
      if (selected) answers.push(selected);
      if (custom) answers.push(custom);
      return [question.id, answers];
    }),
  );
}

function shouldRenderFreeText(question: PendingUserInputQuestion) {
  return question.isOther || question.options.length === 0;
}

function questionHasAnswer(
  question: PendingUserInputQuestion,
  selectedOptions: Record<string, string>,
  freeText: Record<string, string>,
) {
  return Boolean(selectedOptions[question.id] || freeText[question.id]?.trim());
}

async function submitAnswers({
  answers,
  onSubmitAnswers,
  setSubmitting,
}: {
  answers: Record<string, string[]>;
  onSubmitAnswers: (answers: Record<string, string[]>) => Promise<void>;
  setSubmitting: (value: boolean) => void;
}) {
  setSubmitting(true);
  try {
    await onSubmitAnswers(answers);
  } finally {
    setSubmitting(false);
  }
}

function formatPermissionLines(request: PendingApprovalRequest) {
  const lines = [];
  if (request.permissions?.fileSystem?.read?.length) {
    lines.push(`Read: ${request.permissions.fileSystem.read.join(", ")}`);
  }
  if (request.permissions?.fileSystem?.write?.length) {
    lines.push(`Write: ${request.permissions.fileSystem.write.join(", ")}`);
  }
  if (request.permissions?.network?.enabled != null) {
    lines.push(`Network: ${request.permissions.network.enabled ? "enabled" : "disabled"}`);
  }
  return lines;
}
