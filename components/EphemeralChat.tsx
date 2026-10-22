"use client";

import React, { useState, useRef, useEffect } from "react";
import { MessageSquare, Send, Sparkles, ChevronDown } from "lucide-react";
import { useGhostSession } from "@/context/SessionContext";

const MAX_CHARS = 500;

export default function EphemeralChat() {
  const {
    messages,
    unreadCount,
    isChatOpen,
    toggleChat,
    setIsChatOpen,
    sendMessage,
    markChatRead,
    connStatus,
  } = useGhostSession();

  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom whenever messages update or chat is opened
  useEffect(() => {
    if (isChatOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      markChatRead();
    }
  }, [messages, isChatOpen, markChatRead]);

  // Focus input when opened
  useEffect(() => {
    if (isChatOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isChatOpen]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_CHARS) return;

    const sent = sendMessage(trimmed);
    if (sent) {
      setInputText("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  // Only display chat UI if connected or if there are messages from the current active session
  if (connStatus !== "connected" && messages.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end">
      {/* Floating Chat Window */}
      {isChatOpen && (
        <div
          role="dialog"
          aria-label="Ephemeral Live Chat"
          className="w-[calc(100vw-2.5rem)] sm:w-96 h-[460px] max-h-[80vh] mb-3 flex flex-col bg-surface-container-high/95 backdrop-blur-2xl border border-white/[0.1] rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-200"
        >
          {/* Header */}
          <div className="px-4 py-3 bg-surface-container-highest/90 border-b border-white/[0.08] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center text-primary">
                <MessageSquare size={15} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-headline-md text-sm font-semibold text-on-surface">Live Chat</h3>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono-telemetry bg-tertiary/20 text-tertiary border border-tertiary/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse" />
                    RAM Only
                  </span>
                </div>
                <p className="text-[11px] text-on-surface-variant font-mono-telemetry">
                  Direct P2P • Non-persisted • Destroyed on close
                </p>
              </div>
            </div>

            <button
              onClick={() => setIsChatOpen(false)}
              className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-white/[0.06] transition-colors cursor-pointer"
              title="Close Chat"
              aria-label="Close live chat"
            >
              <ChevronDown size={18} />
            </button>
          </div>

          {/* Messages list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 font-body-sm scrollbar-thin">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-4 text-on-surface-variant">
                <Sparkles size={24} className="text-secondary/70 mb-2" />
                <p className="text-xs font-medium text-on-surface">No messages yet</p>
                <p className="text-[11px] mt-1 max-w-[200px]">
                  Send a message to your peer. All text is streamed directly via WebRTC DataChannel and never saved to any storage.
                </p>
              </div>
            ) : (
              messages.map((msg) => {
                const isMe = msg.sender === "me";
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 text-[10px] text-on-surface-variant font-mono-telemetry">
                      <span>{isMe ? "You" : msg.senderName || "Peer"}</span>
                      <span>•</span>
                      <span>
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    <div
                      className={`max-w-[85%] px-3.5 py-2 text-xs rounded-2xl break-words leading-relaxed ${
                        isMe
                          ? "bg-primary text-on-primary rounded-tr-xs shadow-sm font-medium"
                          : "bg-surface-container-highest text-on-surface border border-white/[0.08] rounded-tl-xs"
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Notice & Input Footer */}
          <div className="p-3 bg-surface-container-lowest/80 border-t border-white/[0.06]">
            <form onSubmit={handleSend} className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value.slice(0, MAX_CHARS))}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    connStatus === "connected"
                      ? "Type an ephemeral message..."
                      : "Connecting to peer..."
                  }
                  disabled={connStatus !== "connected"}
                  maxLength={MAX_CHARS}
                  className="w-full bg-surface-container-low border border-white/[0.08] rounded-xl px-3.5 py-2 text-xs text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary/50 transition-colors disabled:opacity-50 pr-12"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono-telemetry text-on-surface-variant/50">
                  {inputText.length}/{MAX_CHARS}
                </span>
              </div>

              <button
                type="submit"
                disabled={connStatus !== "connected" || !inputText.trim()}
                className="p-2 rounded-xl bg-primary text-on-primary hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-sm flex items-center justify-center shrink-0"
                title="Send Message"
                aria-label="Send message"
              >
                <Send size={15} />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Floating Toggle Button / Pill */}
      <button
        onClick={toggleChat}
        aria-label="Toggle live chat"
        className="relative group flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-surface-container-highest/90 hover:bg-surface-container-high backdrop-blur-xl border border-white/[0.12] text-on-surface shadow-[0_8px_24px_rgba(0,0,0,0.4)] transition-all duration-200 cursor-pointer active:scale-95"
      >
        <div className="relative">
          <MessageSquare size={18} className="text-primary group-hover:scale-110 transition-transform" />
          {unreadCount > 0 && !isChatOpen && (
            <span className="absolute -top-1.5 -right-2 px-1.5 py-0.2 min-w-4.5 h-4.5 rounded-full bg-primary text-on-primary text-[10px] font-bold flex items-center justify-center ring-2 ring-surface animate-bounce">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </div>
        <span className="font-label-caps text-xs tracking-wider uppercase font-semibold">
          Live Chat
        </span>
      </button>
    </div>
  );
}
