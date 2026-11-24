import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import type { DecisionValue, Evidence, RunState, Tier } from './types.js';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://oafactory.org/receipt/v1alpha1';
export const PAYLOAD_TYPE = 'application/vnd.in-toto+json';

export interface ReceiptPredicate {
  id: string;
  work_order: string | null;
  issued_at: string;
  change: { host: string; repo: string; number: number | null; base: string };
  run: {
    attempt: number;
    runner: string; runner_model: string;
    reviewer: string; reviewer_model: string;
    cost_usd: number; minutes: number;
    state: RunState; audit: boolean;
  };
  tier: { value: Tier; because: string[] };
  evidence: Evidence[];
  /** What the factory could not establish. Required; may be empty. */
  unverified: string[];
  decision: { value: DecisionValue; mode: 'shadow' | 'earned'; reason: string };
}

export interface Statement {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: string; digest: { gitCommit: string } }>;
  predicateType: typeof PREDICATE_TYPE;
  predicate: ReceiptPredicate;
}

export function buildStatement(subjectName: string, commit: string, predicate: ReceiptPredicate): Statement {
  return { _type: STATEMENT_TYPE, subject: [{ name: subjectName, digest: { gitCommit: commit } }], predicateType: PREDICATE_TYPE, predicate };
}

// --- DSSE ---

export interface Envelope {
  payload: string;
  payloadType: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

/** DSSE pre-authentication encoding. */
export function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);
}

export interface SignedReceipt {
  /** `sigstore` or `local-key`. */
  method: string;
  envelope?: Envelope;
  /** Sigstore bundle, when signed with Sigstore. */
  bundle?: unknown;
}

export interface Signer {
  readonly method: string;
  sign(statement: Statement): Promise<SignedReceipt>;
}

const keyId = (pub: KeyObject) => createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex');

/**
 * Signs with an Ed25519 key held by the Gate. This produces a valid DSSE
 * envelope but is NOT the Sigstore signing the spec requires for earned mode;
 * it exists for tests, demos and air-gapped evaluation.
 */
export class LocalKeySigner implements Signer {
  readonly method = 'local-key';
  private key: KeyObject;
  constructor(privateKeyPem: string) { this.key = createPrivateKey(privateKeyPem); }
  static generate(): { signer: LocalKeySigner; privateKeyPem: string; publicKeyPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    return { signer: new LocalKeySigner(privateKeyPem), privateKeyPem, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
  }
  publicKeyPem(): string { return createPublicKey(this.key).export({ type: 'spki', format: 'pem' }) as string; }
  async sign(statement: Statement): Promise<SignedReceipt> {
    const payload = Buffer.from(JSON.stringify(statement));
    const sig = edSign(null, pae(PAYLOAD_TYPE, payload), this.key);
    return {
      method: this.method,
      envelope: { payload: payload.toString('base64'), payloadType: PAYLOAD_TYPE, signatures: [{ keyid: keyId(createPublicKey(this.key)), sig: sig.toString('base64') }] },
    };
  }
}

/** Verify a local-key DSSE envelope and return the statement it carries. Throws when the signature does not verify. */
export function verifyEnvelope(envelope: Envelope, publicKeyPem: string): Statement {
  const pub = createPublicKey(publicKeyPem);
  const payload = Buffer.from(envelope.payload, 'base64');
  const ok = envelope.signatures.some((s) => edVerify(null, pae(envelope.payloadType, payload), pub, Buffer.from(s.sig, 'base64')));
  if (!ok) throw new Error('receipt signature does not verify');
  return JSON.parse(payload.toString()) as Statement;
}

/**
 * Keyless signing with Sigstore, through the optional `sigstore` npm package.
 * In CI the identity comes from the ambient OIDC token; elsewhere pass
 * SIGSTORE_ID_TOKEN. Not exercised by the test suite: it needs a live Fulcio
 * and Rekor.
 */
export class SigstoreSigner implements Signer {
  readonly method = 'sigstore';
  constructor(private opts: { identityToken?: string } = {}) {}
  async sign(statement: Statement): Promise<SignedReceipt> {
    let mod: { attest: (payload: Buffer, payloadType: string, opts?: Record<string, unknown>) => Promise<unknown> };
    try {
      const name = 'sigstore';
      mod = await import(name);
    } catch {
      throw new Error('Sigstore signing needs the `sigstore` package: npm install sigstore');
    }
    const token = this.opts.identityToken ?? process.env.SIGSTORE_ID_TOKEN;
    const bundle = await mod.attest(Buffer.from(JSON.stringify(statement)), PAYLOAD_TYPE, token ? { identityToken: token } : {});
    return { method: this.method, bundle };
  }
}

/**
 * `required` is the evidence the change's tier asks for. Evidence outside it is
 * shown as extra information, so a low-risk change is not presented as failing
 * checks it never needed.
 */
export function renderReceiptComment(st: Statement, signed?: SignedReceipt, required?: readonly string[]): string {
  const p = st.predicate;
  const icon = { merge: 'merge', would_merge: 'would merge', escalate: 'escalate', abandon: 'abandoned' }[p.decision.value];
  const needed = (kind: string) => !required || required.includes(kind);
  const result = (e: Evidence) => (e.met ? 'met' : needed(e.kind) ? '**not met**' : 'not met');
  const rows = p.evidence.map((e) => `| \`${e.kind}\` | ${needed(e.kind) ? 'yes' : 'no'} | ${result(e)} | ${e.source} |`).join('\n');
  return [
    `### OAFactory receipt \`${p.id}\``,
    '',
    `**Decision: ${icon}** (${p.decision.mode} mode). ${p.decision.reason}`,
    '',
    `**Tier ${p.tier.value}**: ${p.tier.because.slice(0, 5).join('; ')}${p.tier.because.length > 5 ? '; ...' : ''}`,
    '',
    `| Evidence | Required at tier ${p.tier.value} | Result | Source |`, '|---|---|---|---|', rows || '| (none collected) | | | |',
    '',
    p.unverified.length ? `**Not verified:**\n${p.unverified.map((u) => `- ${u}`).join('\n')}` : '**Not verified:** nothing recorded.',
    '',
    `<sub>Commit \`${st.subject[0]?.digest.gitCommit.slice(0, 12)}\`. ${signed ? `Signed (${signed.method}).` : 'Unsigned.'}${p.run.audit ? ' Selected for audit.' : ''}</sub>`,
  ].join('\n');
}
