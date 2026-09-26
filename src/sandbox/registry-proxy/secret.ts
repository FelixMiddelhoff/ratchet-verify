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

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----([\s\S]+?)-----END (?:RSA |EC |)PRIVATE KEY-----/;

/**
 * TLS client certificate for a registry that demands mutual TLS. The certificate is public; the private key is secret and
 * follows the same rules as a token: it never serialises, and `tlsOptions()` is called from exactly one place (the upstream
 * request). Encrypted keys are refused (no passphrase support): a key must be usable as is.
 */
export class ClientCertificate {
  readonly #cert: string;
  readonly #key: string;

  constructor(cert: string, key: string) {
    if (typeof cert !== "string" || !PEM_CERT.test(cert)) throw new TypeError("client certificate must be a PEM certificate");
    if (typeof key !== "string" || /ENCRYPTED/.test(key)) throw new TypeError("client key must be an unencrypted PEM private key");
    if (!PEM_KEY.test(key)) throw new TypeError("client key must be an unencrypted PEM private key");
    if (cert.length > 64 * 1024 || key.length > 64 * 1024) throw new TypeError("client certificate or key is too large");
    this.#cert = cert;
    this.#key = key;
    Object.freeze(this);
  }

  /** Options for `https.request`. Only the upstream request may call this. */
  tlsOptions(): { cert: string; key: string } {
    return { cert: this.#cert, key: this.#key };
  }

  /** Raw strings the redactor must scrub: the whole PEM, its bare base64 body, and each body line (a truncated or wrapped log line). */
  material(): string[] {
    const lines = (PEM_KEY.exec(this.#key)?.[1] ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 16);
    const body = lines.join("");
    return [this.#key.trim(), ...(body.length >= MIN_SECRET_LENGTH ? [body] : []), ...lines];
  }

  toJSON(): { cert: string; key: string } {
    return { cert: REDACTED, key: REDACTED };
  }
  toString(): string {
    return `ClientCertificate(${REDACTED})`;
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
