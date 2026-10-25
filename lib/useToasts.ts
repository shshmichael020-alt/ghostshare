"use client";

import { useCallback, useRef, useState } from "react";

export type Toast = {
  id: string;
  message: string;
  tone: "default" | "error" | "success";
};

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: Toast["tone"] = "default") => {
      const id = String(++idRef.current);
      setToasts((prev) => {
        // Prevent duplicate consecutive toasts with identical message and tone
        if (prev.length > 0 && prev[prev.length - 1].message === message) {
          return prev;
        }
        // Limit visible toasts to max 3 on screen
        return [...prev.slice(-2), { id, message, tone }];
      });
      setTimeout(() => {
        dismiss(id);
      }, 4000);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
