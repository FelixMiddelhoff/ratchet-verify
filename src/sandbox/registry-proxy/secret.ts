import { inspect } from "node:util";

/**
 * Secret material for the registry proxy. Nothing here ever serialises the
 * value: JSON, String(), template strings, util.inspect (console.log) and
 * structuredClone all yield a placeholder or an empty object. The only way out
 * is `reveal()`, called from exactly one place (header injection).
 */
export const REDACTED = "[REDACTED]";
export const MIN_SECRET_LENGTH = 8;

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
      throw new TypeError(`secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("secret must not contain control characters");
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return REDACTED;
  }
  toString(): string {
    return REDACTED;
  }
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

export type CredentialType = "bearer" | "basic";

/** A registry credential. `secret` is the bearer token, or `username:password` for basic. */
export class Credential {
  readonly type: CredentialType;
  readonly #secret: Secret;

  constructor(type: CredentialType, secret: string) {
    if (type !== "bearer" && type !== "basic") throw new TypeError("credential type must be bearer or basic");
    if (type === "basic" && !secret.includes(":")) throw new TypeError("basic credential secret must be username:password");
    this.type = type;
    this.#secret = new Secret(secret);
    Object.freeze(this);
  }

  /** The Authorization header value. Only header injection may call this. */
  authorization(): string {
    const raw = this.#secret.reveal();
    return this.type === "bearer" ? `Bearer ${raw}` : `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  /** Raw strings the redactor must scrub (it derives the encoded forms itself). */
  material(): string[] {
    const raw = this.#secret.reveal();
    if (this.type === "bearer") return [raw];
    const password = raw.slice(raw.indexOf(":") + 1);
    return password.length >= MIN_SECRET_LENGTH ? [raw, password] : [raw];
  }

  toJSON(): { type: CredentialType; secret: string } {
    return { type: this.type, secret: REDACTED };
  }
  toString(): string {
    return `Credential(${this.type}, ${REDACTED})`;
  }
  [inspect.custom](): string {
    return this.toString();
  }
}

function base64Fragments(raw: string, urlSafe: boolean): string[] {
  const out: string[] = [];
  const bytes = Buffer.from(raw, "utf8");
  for (let pad = 0; pad < 3; pad++) {
    const enc = Buffer.concat([Buffer.alloc(pad), bytes]).toString(urlSafe ? "base64url" : "base64");
    const start = Math.ceil((pad * 8) / 6);
    const end = Math.floor(((pad + bytes.length) * 8) / 6);
    const frag = enc.slice(start, end);
    if (frag.length >= MIN_SECRET_LENGTH) out.push(frag);
  }
  return out;
}

/** Every textual form of a secret we know how to recognise. */
export function secretForms(raw: string): string[] {
  const forms = new Set<string>([raw, encodeURIComponent(raw), Buffer.from(raw, "utf8").toString("hex")]);
  for (const f of base64Fragments(raw, false)) forms.add(f);
  for (const f of base64Fragments(raw, true)) forms.add(f);
  const uri = encodeURIComponent(raw);
  for (const f of base64Fragments(uri, false)) forms.add(f);
  return [...forms].filter((f) => f.length >= MIN_SECRET_LENGTH);
}

export type Redactor = (text: string) => string;

/** Builds a scrubber for every form (raw, base64 at all alignments, url-encoded, hex) of the given secrets. */
export function createRedactor(materials: readonly string[]): Redactor {
  const forms = [...new Set(materials.flatMap(secretForms))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = String(text);
    for (const form of forms) {
      if (out.includes(form)) out = out.split(form).join(REDACTED);
    }
    return out;
  };
}

export function redactError(redact: Redactor, err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redact(msg);
}
