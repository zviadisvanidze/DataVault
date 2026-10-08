"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { request } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { date } from "@/lib/utils";
import {
  Alert,
  Badge,
  Button,
  Confirm,
  ErrorState,
  Loading,
  PageHeading,
  useToast,
} from "@/components/ui";
const suggestions = [
  "How much of our file allowance have we used?",
  "Explain our current billing estimate.",
  "Which files can I access?",
  "Help me write a data organization checklist.",
];
export default function AssistantWorkspace({ floating = false }) {
  const [showHistory, setShowHistory] = useState(false);
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(null),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [removing, setRemoving] = useState(null),
    [pending, setPending] = useState("");
  const toast = useToast(),
    controller = useRef(null),
    end = useRef(null),
    input = useRef(null),
    sending = useRef(false);
  const history = useResource(
    (signal) => request(`/ai/conversations?page=${page}&limit=20`, { signal }),
    [page],
  );
  const thread = useResource(
    (signal) =>
      selected
        ? request(`/ai/conversations/${selected}`, { signal })
        : Promise.resolve(null),
    [selected],
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [thread.data, busy]);
  function select(id) {
    if (sending.current) return;
    setShowHistory(false);
    setSelected(id);
    setDraft("");
    setError(null);
    setPending("");
  }
  async function send(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending.current || thread.loading || thread.error) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setPending(message);
    controller.current = new AbortController();
    try {
      const result = await request("/ai/chat", {
        method: "POST",
        body: { message, ...(selected ? { conversationId: selected } : {}) },
        signal: controller.current.signal,
      });
      // Re-read the persisted transcript: commit recovery may return only the assistant message.
      setDraft("");
      setSelected(result.conversation.id);
      if (selected === result.conversation.id) thread.reload();
      setPage(1);
      history.reload();
    } catch (e) {
      if (!controller.current.signal.aborted) {
        setError(e);
        history.reload();
      }
    } finally {
      sending.current = false;
      setBusy(false);
      setPending("");
    }
  }
  const disabled = error?.code === "ai_disabled";
  return (
    <>
      {!floating && (
        <PageHeading
          eyebrow="A LITTLE CLARITY, ON DEMAND"
          title="Your workspace, in conversation."
          description="Ask a question. Understand your data. Find your next step."
          action={
            <Badge tone="green">
              <ShieldCheck size={13} />
              Read-only workspace access
            </Badge>
          }
        />
      )}

      <div
        className={`assistant-layout ${floating ? "compact-assistant" : ""} ${showHistory ? "show-history" : ""}`}
      >
        <aside className="panel conversation-sidebar">
          <div className="conversation-heading">
            <h2>Conversations</h2>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                select(null);
                input.current?.focus();
              }}
            >
              <Plus size={15} />
              New
            </Button>
          </div>
          {history.loading ? (
            <Loading label="Loading conversations" />
          ) : history.error ? (
            <ErrorState error={history.error} retry={history.reload} />
          ) : (
            <>
              <div className="conversation-list">
                {history.data.conversations.length ? (
                  history.data.conversations.map((c) => (
                    <div
                      className={`conversation-item ${selected === c.id ? "selected" : ""}`}
                      key={c.id}
                    >
                      <button
                        disabled={busy}
                        onClick={() => select(c.id)}
                        aria-current={selected === c.id ? "true" : undefined}
                      >
                        <MessageSquare size={16} />
                        <span>
                          <strong>{c.title}</strong>
                          <small>
                            {date(c.updatedAt)} · {c.messageCount} messages
                          </small>
                        </span>
                      </button>
                      <button
                        disabled={busy}
                        className="icon-button"
                        aria-label={`Delete conversation: ${c.title}`}
                        onClick={() => setRemoving(c)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="conversation-empty">
                    <MessageSquare size={24} />
                    <h3>A fresh start</h3>
                    <p>
                      Your saved conversations will appear here after your first
                      response.
                    </p>
                  </div>
                )}
              </div>
              <div className="conversation-pagination">
                <button
                  disabled={busy || page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span>Page {page}</span>
                <button
                  disabled={busy || page * 20 >= history.data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
          <div className="conversation-privacy">
            <ShieldCheck size={15} />
            <p>
              History is scoped to your account. Workspace answers respect your
              access permissions.
            </p>
          </div>
        </aside>
        <section className="panel assistant-chat" aria-label="AI Assistant">
          <header className="assistant-header">
            {floating && (
              <button
                className="button secondary chat-history-toggle"
                disabled={busy}
                onClick={() => setShowHistory((h) => !h)}
              >
                {showHistory ? "Back to chat" : "History"}
              </button>
            )}
            <span className="assistant-avatar">
              <MessageSquare size={20} />
            </span>
            <div>
              <h2>DataVault Assistant</h2>
              <p>
                {selected
                  ? "Continue your conversation"
                  : "General help. Workspace context."}
              </p>
            </div>
            <button
              className="icon-button"
              disabled={busy}
              aria-label="Refresh conversation history"
              onClick={() => {
                history.reload();
                thread.reload();
              }}
            >
              <RefreshCw size={16} />
            </button>
          </header>
          <div
            className="chat-transcript"
            aria-label="Conversation messages"
            aria-busy={busy}
          >
            {selected && thread.loading ? (
              <Loading label="Loading your conversation" />
            ) : thread.error ? (
              <ErrorState error={thread.error} retry={thread.reload} />
            ) : !selected && !busy ? (
              <div className="assistant-welcome">
                <span className="assistant-emblem">
                  <MessageSquare size={32} strokeWidth={1.3} />
                </span>
                <span className="eyebrow">PUT YOUR WORKSPACE INTO WORDS</span>
                <h2>What would you like to understand?</h2>
                <p>
                  Ask about your plan, usage, company, or visible files—or get
                  help with writing, coding, and ideas.
                </p>
                <div className="suggestion-grid">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setDraft(s);
                        input.current?.focus();
                      }}
                    >
                      {s}
                      <ArrowUp size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-messages">
                {thread.data?.messages.map((m) => (
                  <article key={m.id} className={`chat-message ${m.role}`}>
                    <span>
                      {m.role === "user" ? "You" : "DataVault Assistant"}
                    </span>
                    <div>{m.content}</div>
                  </article>
                ))}
              </div>
            )}
            {busy && (
              <div role="status" className="chat-pending">
                <article className="chat-message user">
                  <span>You · Sending</span>
                  <div>{pending}</div>
                </article>
                <Loading label="Working on your answer" />
              </div>
            )}
            <div ref={end} />
          </div>
          <div className="chat-composer">
            <Alert>{error?.message}</Alert>
            {disabled && (
              <p className="small muted">
                AI must be enabled by the service administrator. Your
                conversation history is still available.
              </p>
            )}
            {error && !disabled && (
              <p className="small muted">
                Your draft has been kept. Refresh history before sending again
                if the result was interrupted.
              </p>
            )}
            <form onSubmit={send}>
              <label className="sr-only" htmlFor="assistant-message">
                Message the assistant
              </label>
              <textarea
                ref={input}
                id="assistant-message"
                rows={3}
                maxLength={50000}
                value={draft}
                disabled={busy || disabled}
                placeholder="Ask about your workspace, or bring a new idea…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if (!e.repeat) e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="composer-footer">
                <span>Enter to send · Shift+Enter for a new line</span>
                <Button
                  busy={busy}
                  disabled={
                    !draft.trim() ||
                    disabled ||
                    thread.loading ||
                    !!thread.error
                  }
                >
                  <ArrowUp size={16} />
                  Send
                </Button>
              </div>
            </form>
            <p className="composer-note">
              The assistant can read authorized file metadata, not file
              contents. Keep passwords and other secrets out of messages.
            </p>
            {disabled && (
              <Button variant="secondary" onClick={() => setError(null)}>
                Try after service is enabled
              </Button>
            )}
          </div>
        </section>
      </div>
      {removing && (
        <Confirm
          title="Delete this conversation?"
          description={`“${removing.title}” and its messages will be permanently removed from your history.`}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await request(`/ai/conversations/${removing.id}`, {
              method: "DELETE",
            });
            if (selected === removing.id) select(null);
            if (page > 1 && history.data?.conversations.length === 1)
              setPage((p) => p - 1);
            history.reload();
            toast("Conversation deleted");
          }}
        />
      )}
    </>
  );
}
