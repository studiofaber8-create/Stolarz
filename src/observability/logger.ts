export interface LogFields {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export class JsonLogger implements Logger {
  public info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  public warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  public error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...withoutUndefined(fields),
    });
    if (level === "error") console.error(record);
    else if (level === "warn") console.warn(record);
    else console.log(record);
  }
}

function withoutUndefined(fields: LogFields): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined,
    ),
  );
}
