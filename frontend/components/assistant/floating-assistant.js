"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, MessageCircle, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import AssistantWorkspace from "./assistant-workspace";
export default function FloatingAssistant() {
  const { user } = useAuth(),
    pathname = usePathname();
  const [open, setOpen] = useState(false),
    [visited, setVisited] = useState(false);
  const trigger = useRef(null),
    panel = useRef(null);
  function show() {
    setVisited(true);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("assistant") === "open")
      show();
  }, [pathname]);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  if (pathname.startsWith("/admin")) return null;
  return (
    <div className="floating-assistant">
      <section
        ref={panel}
        tabIndex={-1}
        hidden={!open}
        id="datavault-chat"
        className="floating-chat-panel"
        role="dialog"
        aria-label="DataVault chat"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.target.closest("dialog")) {
            e.stopPropagation();
            close();
          }
        }}
      >
        <header className="floating-chat-top">
          <span>
            <MessageCircle size={19} />
            Your DataVault assistant
          </span>
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close chat"
          >
            <X size={20} />
          </button>
        </header>
        {user ? (
          visited && <AssistantWorkspace key={user._id} floating />
        ) : (
          <div className="chat-signin">
            <span className="assistant-emblem">
              <MessageCircle size={32} />
            </span>
            <h2>A little help, right here.</h2>
            <p>
              Sign in to ask questions about your workspace, explore your usage,
              or pick up a previous conversation.
            </p>
            <Link className="button" href="/login" onClick={close}>
              Sign in to chat <ArrowRight size={16} />
            </Link>
          </div>
        )}
      </section>
      <button
        ref={trigger}
        className="chat-launcher"
        aria-label={open ? "Minimize AI chat" : "Open AI chat"}
        aria-expanded={open}
        aria-controls="datavault-chat"
        onClick={open ? close : show}
      >
        <svg
          className="vault-robot"
          viewBox="0 0 88 92"
          fill="none"
          aria-hidden="true"
        >
          <ellipse
            cx="44"
            cy="85"
            rx="24"
            ry="4"
            fill="#153e35"
            opacity=".12"
          />
          <g className="robot-body">
            <path
              d="M44 19V12"
              stroke="#087e6f"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <circle
              className="robot-antenna"
              cx="44"
              cy="9"
              r="5"
              fill="#a4d9ba"
              stroke="#087e6f"
              strokeWidth="2"
            />
            <rect x="24" y="57" width="40" height="23" rx="11" fill="#087e6f" />
            <path
              d="M30 77V81M58 77V81"
              stroke="#184b3f"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <path
              className="robot-arm"
              d="M66 61L73 54"
              stroke="#087e6f"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <path
              d="M22 62L17 68"
              stroke="#087e6f"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <rect x="10" y="34" width="9" height="16" rx="4.5" fill="#087e6f" />
            <rect x="69" y="34" width="9" height="16" rx="4.5" fill="#087e6f" />
            <rect
              x="16"
              y="20"
              width="56"
              height="44"
              rx="19"
              fill="#d8eee2"
              stroke="#087e6f"
              strokeWidth="2.5"
            />
            <rect x="22" y="27" width="44" height="29" rx="12" fill="#183e36" />
            {open ? (
              <path
                d="M32 36L39 43M39 36L32 43M49 36L56 43M56 36L49 43"
                stroke="#b9efcc"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            ) : (
              <g className="robot-eyes" fill="#b9efcc">
                <rect x="31" y="35" width="7" height="10" rx="3.5" />
                <rect x="50" y="35" width="7" height="10" rx="3.5" />
              </g>
            )}
            <path
              d="M40 49Q44 52 48 49"
              stroke="#b9efcc"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <rect x="38" y="67" width="12" height="5" rx="2.5" fill="#b9efcc" />
          </g>
        </svg>
      </button>
    </div>
  );
}
