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
      setToasts((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => {
        dismiss(id);
      }, 4000);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
