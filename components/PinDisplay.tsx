export default function PinDisplay({ code }: { code: string | null }) {
  const digits = (code ?? "········").split("");
  return (
    <div className="flex gap-1.5 justify-center">
      {digits.map((d, i) => (
        <div
          key={i}
          className="w-9 h-12 sm:w-10 sm:h-14 rounded-md border flex items-center justify-center font-mono-relay text-xl sm:text-2xl"
          style={{
            borderColor: "var(--relay-line)",
            background: "var(--relay-panel-raised)",
            color: code ? "var(--relay-amber)" : "var(--relay-text-dim)",
          }}
        >
          {d}
        </div>
      ))}
    </div>
  );
}
