type LogLevel = "silent" | "info" | "debug";

export function createLogger(level: LogLevel) {
  const rank: Record<LogLevel, number> = { silent: 2, info: 1, debug: 0 };
  const write = (
    kind: "info" | "error" | "debug",
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (rank[level] > rank[kind === "error" ? "info" : kind]) return;
    const safeFields = fields ? redact(fields) : undefined;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: kind,
      message,
      ...(safeFields ? { fields: safeFields } : {}),
    });
    (kind === "error" ? console.error : console.log)(line);
  };
  return {
    info: (message: string, fields?: Record<string, unknown>) =>
      write("info", message, fields),
    error: (message: string, fields?: Record<string, unknown>) =>
      write("error", message, fields),
    debug: (message: string, fields?: Record<string, unknown>) =>
      write("debug", message, fields),
  };
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        /secret|token|authorization|cookie|password|api[-_]?key|code|state|verifier/i.test(
          key,
        )
      )
        return [key, "[REDACTED]"];
      if (item && typeof item === "object" && !Array.isArray(item))
        return [key, redact(item as Record<string, unknown>)];
      return [key, item];
    }),
  );
}
