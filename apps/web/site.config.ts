/**
 * Every address this app links to is resolved here. When something is redeployed or
 * re-run, this is the only file that changes — and most of it reads the records the other
 * packages already keep, so a re-run usually needs no edit at all.
 *
 * Read on the server only: the pages hand client components the few values they need, so
 * the deployment records never ship to the browser.
 *
 * Contract addresses are deliberately not shown on the landing. They are listed in PROOF.md.
 */

import deployment from '../../packages/contracts/deployments/hedera-testnet.json';
import deviceProof from '../../packages/contracts/deployments/device-proof.json';
import notesFile from '../../packages/substreams/notes.json';
import type { LifecycleStep, NoteRecord, VaultLeg } from './lib/notes';

const repo = 'https://github.com/RaYYeR220/plimsoll';
const hashscan = 'https://hashscan.io/testnet';
const basescan = 'https://basescan.org';

/** A HashScan link for a transaction, from an EVM hash or a Hedera transaction id. */
export const txUrl = (id: string): string =>
  `${hashscan}/transaction/${id.startsWith('0x') ? id : id.replace('@', '-').replace(/\.(\d+)$/, '-$1')}`;

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* ── the device sequence ─────────────────────────────────────────────────
   Steps are matched by the call they record, not by position, so a re-run that
   adds or reorders steps still resolves. A missing step leaves the sequence
   unlinked rather than half-linked. */
type Step = {
  label?: unknown;
  action?: unknown;
  decision?: unknown;
  nonce?: unknown;
  mandateText?: unknown;
  screens?: unknown;
  call?: unknown;
  status?: unknown;
  tx?: unknown;
  revertData?: unknown;
  halted?: unknown;
  verifierHalted?: unknown;
  loadLineBps?: unknown;
};
const steps: Step[] = Array.isArray((deviceProof as { steps?: unknown }).steps)
  ? (deviceProof as { steps: Step[] }).steps
  : [];
const stepTx = (call: string, status: string): string | null => {
  const step = steps.find((s) => s.call === call && s.status === status);
  return typeof step?.tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(step.tx) ? step.tx : null;
};
const halt = stepTx('LoadLine.halt', 'SUCCESS');
const refusedResume = stepTx('LoadLine.resume', 'REVERTED');
const resume = stepTx('LoadLine.resume', 'SUCCESS');

export type DeviceLinks = { halt: string; refusedResume: string; resume: string };

const denial = deployment.denial_artifact;
const ATTESTED_PAYMENT = '0.0.7162784@1789121899.540907773';

/* ── the notes ───────────────────────────────────────────────────────────
   Identity, obligation and lifecycle come from the deployment record; the vault
   set and the negative-control flag from the shared notes file. */

const noteB = deployment.ats.notes['PLIM-B'];
const noteA = deployment.ats.issuedNote;
const defs = notesFile.notes as Record<string, { market: string; vaults: string[]; negativeControl: boolean }>;
const defOf = (market: string) => Object.values(defs).find((d) => d.market === market);

/**
 * TEMPORARY MIRROR — delete when the backing package emits its vault specification as
 * JSON, and read that file here instead. These values are copied from
 * packages/backing/src/config.ts, which is TypeScript and cannot be imported.
 * The deposits are planned, not recorded as made, and every screen says so.
 */
const PLAN: Record<string, readonly VaultLeg[]> = {
  'PLIM-B': [
    leg('morpho', 'Gauntlet USDC Prime', 'Morpho (MetaMorpho)', '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61', 'USDC', 8),
    leg('aave', 'Wrapped Aave Base USDC', 'Aave v3 static aToken', '0xC768c589647798a6EE01A91FdE98EF2ed046DBD6', 'USDC', 4),
    leg('spark', 'Spark USDC Vault', 'Spark (PSM3)', '0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858', 'USDC', 'rest'),
  ],
  // The negative control's own vault, disjoint from PLIM-B's: a position backs one note.
  'PLIM-A': [leg('fluid', 'Fluid USDC', 'Fluid', '0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169', 'USDC', 1)],
};

/**
 * What the plan does when it is tested, measured on a fork of Base rather than imagined.
 * Nothing has been deposited yet, so every figure here describes a plan.
 */
const PLIM_B_SCENARIO = [
  { label: 'Funded as planned', coverage: '140.00%', clear: true, detail: 'Against a $10.00 obligation and a 100.00% line.' },
  {
    label: 'Redeem the Morpho position',
    coverage: '60.00%',
    clear: false,
    detail: 'Forty points under the line. One position leaving is enough to stop the market.',
  },
  {
    label: 'Redeem either other position',
    coverage: '110.00%',
    clear: true,
    detail: 'Still clear: the line is about value, not about how many positions exist.',
  },
  { label: 'Put the Morpho position back', coverage: '140.00%', clear: true, detail: 'The refusal clears because the backing returned.' },
] as const;

function leg(
  key: string,
  name: string,
  protocol: string,
  address: string,
  asset: string,
  planned: number | 'rest',
): VaultLeg {
  return { key, name, protocol, address, asset, planned, href: `${basescan}/address/${address}` };
}

const LIFECYCLE_LABEL: Record<string, string> = {
  addIssuer: 'Issuer role granted',
  grantKyc: 'Holder cleared for KYC',
  issueByPartition: 'Notes issued',
};

function lifecycleOf(raw: ReadonlyArray<{ step: string; tx: string; result: string }>): LifecycleStep[] {
  const seen = new Map<string, number>();
  return raw.map((s) => {
    const n = (seen.get(s.step) ?? 0) + 1;
    seen.set(s.step, n);
    const base = LIFECYCLE_LABEL[s.step] ?? s.step;
    return {
      step: n > 1 ? `${base} (${n})` : base,
      tx: s.tx,
      href: txUrl(s.tx),
      result: s.result,
    };
  });
}

const plimB: NoteRecord = {
  market: noteB.symbol,
  name: noteB.name,
  isin: noteB.isin,
  hederaId: noteB.hederaId,
  address: noteB.address,
  href: noteB.hashscan,
  noteId: noteB.noteId,
  obligation: {
    units: noteB.obligation.totalSupplyBaseUnits,
    decimals: noteB.obligation.tokenDecimals,
    nominalValue: noteB.obligation.nominalValue,
    nominalValueDecimals: noteB.obligation.nominalValueDecimals,
    currency: 'USD',
  },
  thresholdBps: noteB.registration.loadLine.loadLineBps,
  thresholdMandate: { tx: noteB.registration.loadLine.tx, href: noteB.registration.loadLine.hashscan },
  negativeControl: defOf('PLIM-B')?.negativeControl ?? false,
  nominatedVaults: defOf('PLIM-B')?.vaults ?? [],
  vaultSetSettled: (defOf('PLIM-B')?.vaults ?? []).length > 0,
  /* coverageOf(noteId) on CoverageOracle, read 2026-09-13: 0 bps, Unproven, AttestationExpired. */
  oracle: { verdict: 'Unproven', reason: 'AttestationExpired', readOn: '2026-09-13' },
  recorded: { family: 'evidence', reason: 'attestation-expired' },
  recordSeqs: [22],
  plan: PLAN['PLIM-B'],
  plannedBackingUsd: 14,
  scenario: PLIM_B_SCENARIO,
  lifecycle: [
    ...lifecycleOf(noteB.lifecycle),
    {
      step: 'Load line set on the device',
      tx: noteB.registration.loadLine.tx,
      href: noteB.registration.loadLine.hashscan,
      result: 'SUCCESS',
    },
    {
      step: 'Escrow allowance approved',
      tx: noteB.listing.approval.tx,
      href: noteB.listing.approval.hashscan,
      result: noteB.listing.approval.result,
    },
  ],
  /* The deployment record's own reason predates setVaultSet and still calls the set
     unfinished, so it is restated here from what the chain says now. */
  listing: {
    status: noteB.listing.status,
    why: 'placeAsk calls LoadLine.requireClear(PLIM-B), and the oracle reads the note as unproven: its last attestation has expired. The vault set is registered; the holder on Base is not funded yet, so there is nothing new to attest.',
  },
  note: 'The right-sized series: a $10.00 obligation against Base backing, so it is the note that should clear.',
};

const plimA: NoteRecord = {
  market: noteA.symbol,
  name: noteA.name,
  isin: noteA.isin,
  hederaId: noteA.hederaId,
  address: noteA.address,
  href: noteA.hashscan,
  noteId: deployment.note_under_management.noteId,
  /* Read from the note on 2026-09-12: totalSupply() 1,000,000 at decimals() 2, nominal
     value 100.00. The deployment record carries no obligation block for PLIM-A yet. */
  obligation: { units: 1_000_000, decimals: 2, nominalValue: 10_000, nominalValueDecimals: 2, currency: 'USD' },
  thresholdBps: 10_000,
  thresholdMandate: null,
  negativeControl: defOf('PLIM-A')?.negativeControl ?? true,
  nominatedVaults: defOf('PLIM-A')?.vaults ?? [],
  vaultSetSettled: (defOf('PLIM-A')?.vaults ?? []).length > 0,
  /* coverageOf(noteId) on CoverageOracle, read 2026-09-13: 0 bps, Unproven, NoAttestation. */
  oracle: { verdict: 'Unproven', reason: 'NoAttestation', readOn: '2026-09-13' },
  recorded: { family: 'evidence', reason: 'no-attestation' },
  recordSeqs: [23],
  plan: PLAN['PLIM-A'],
  /* One dollar of USDC against a $1,000,000 obligation. Planned, not deposited, and the
     source of a 0.00% that is not an empty wallet. */
  plannedBackingUsd: 1,
  lifecycle: [],
  listing: {
    status: 'not listed',
    why: 'The negative control is never meant to clear: a $1,000,000 obligation against about $15 of backing.',
  },
  note: 'The negative control. It must always refuse, and a clean result on the other note is worth nothing without it.',
};

/* ── the device transcript ───────────────────────────────────────────────
   Mapped from the deployment record rather than retold. Every mandate carries the
   text the device rendered and the screens it showed, verbatim. */

const ERROR_NAMES: Record<string, string> = {
  // each verified against its own signature, not taken from a note
  '0xa29963d7': 'NotGatekeeper', // NotGatekeeper(address)
  '0x59d2759c': 'NotLoadLine', // NotLoadLine(address)
  '0x5f7e60e8': 'WrongAuthority', // WrongAuthority(address,address)
  '0x20e11789': 'MandateValueMismatch', // MandateValueMismatch(bytes32,uint256,uint32)
};

export type TranscriptEntry =
  | {
      readonly kind: 'mandate';
      readonly label: string;
      readonly action: string;
      readonly decision: string;
      readonly approved: boolean;
      readonly nonce: number | null;
      readonly mandateText: string;
      readonly screens: readonly string[];
    }
  | {
      readonly kind: 'call';
      readonly label: string;
      readonly call: string;
      readonly status: string;
      readonly tx: string;
      readonly href: string;
      readonly error: string | null;
    }
  | {
      readonly kind: 'state';
      readonly label: string;
      readonly halted: boolean;
      readonly loadLineBps: number | null;
    };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function toEntry(s: Step): TranscriptEntry | null {
  const label = str(s.label) ?? '';
  const action = str(s.action);
  const decision = str(s.decision);
  if (action && decision) {
    return {
      kind: 'mandate',
      label,
      action,
      decision,
      approved: decision.toUpperCase().startsWith('APPROVED'),
      nonce: num(s.nonce),
      mandateText: str(s.mandateText) ?? '',
      screens: Array.isArray(s.screens) ? (s.screens as string[]).filter((x) => typeof x === 'string') : [],
    };
  }
  const call = str(s.call);
  const tx = str(s.tx);
  if (call && tx) {
    const selector = str(s.revertData)?.slice(0, 10) ?? null;
    return {
      kind: 'call',
      label,
      call,
      status: str(s.status) ?? '',
      tx,
      href: txUrl(tx),
      error: selector ? (ERROR_NAMES[selector] ?? selector) : null,
    };
  }
  if (typeof s.halted === 'boolean') {
    return { kind: 'state', label, halted: s.halted, loadLineBps: num(s.loadLineBps) };
  }
  return null;
}

export const deviceTranscript: readonly TranscriptEntry[] = steps
  .map(toEntry)
  .filter((e): e is TranscriptEntry => e !== null);

/** The device that holds the authority, and the market this transcript ran against. */
export const deviceInfo = {
  market: (deviceProof as { market?: string }).market ?? 'PLIM-A',
  ...(deviceProof as { device: { emulator: string; model: string; app: string; address: string } }).device,
};

/** PLIM-B's own threshold mandate, with the screens the device showed for it. */
export const thresholdMandate = {
  market: 'PLIM-B',
  loadLineBps: noteB.registration.loadLine.loadLineBps,
  nonce: noteB.registration.loadLine.nonce,
  mandateText: noteB.registration.loadLine.mandateText,
  screens: noteB.registration.loadLine.screens as readonly string[],
  tx: noteB.registration.loadLine.tx,
  href: noteB.registration.loadLine.hashscan,
};

const PLIM_B_PAYMENT = '0.0.7162784@1789172046.246807405';

/**
 * Records on the audit topic, each decoded from the mirror node on 2026-09-13.
 *
 * Every one of them is computed from FIXTURE backing, and each record says so itself.
 * 22 and 23 name the real notes, but their positions are invented and their vault-set
 * hashes are the placeholders setVaultSet has since replaced: they prove the path on the
 * notes, not the notes' backing. 17 to 19 are the service's own test notes. The first
 * reading of the notes' real Base positions will be a new record, and belongs here.
 */
export const auditRecords = [
  {
    seq: 22,
    note: 'PLIM-B',
    decision: 'Attested',
    family: null,
    reason: null,
    bps: 15_000,
    backing: '$15.00',
    obligation: '$10.00',
    charged: true,
    settlement: PLIM_B_PAYMENT,
    href: txUrl(PLIM_B_PAYMENT),
    source: 'fixture:plimsoll-base-backing-v0',
    retiredVaultSet: true,
    proof: 'Charged once, and the charge is real. The backing it was charged for is not.',
  },
  {
    seq: 23,
    note: 'PLIM-A',
    decision: 'Refused',
    family: 'asset',
    reason: 'coverage_below_floor',
    bps: 0,
    backing: '$15.00',
    obligation: '$1,000,000.00',
    charged: false,
    settlement: null,
    href: null,
    source: 'fixture:plimsoll-base-backing-v0',
    retiredVaultSet: true,
    proof: 'No transfer exists. A 0.00% that is not an empty wallet: the amounts are the finding.',
  },
  {
    seq: 17,
    note: 'NOTE-ALPHA',
    decision: 'Attested',
    family: null,
    reason: null,
    bps: 13_000,
    backing: '$325,000.00',
    obligation: '$250,000.00',
    charged: true,
    settlement: ATTESTED_PAYMENT,
    href: txUrl(ATTESTED_PAYMENT),
    source: 'fixture:plimsoll-vault-flows-v0.3.1',
    retiredVaultSet: false,
    proof: 'The charge is one transfer, and it is on the ledger.',
  },
  {
    seq: 18,
    note: 'NOTE-BRAVO',
    decision: 'Refused',
    family: 'asset',
    reason: 'coverage_below_floor',
    bps: 8_700,
    backing: '$217,500.00',
    obligation: '$250,000.00',
    charged: false,
    settlement: null,
    href: null,
    source: 'fixture:plimsoll-vault-flows-v0.3.1',
    retiredVaultSet: false,
    proof: 'No transfer exists. The payment was authorised and never submitted.',
  },
  {
    seq: 19,
    note: 'NOTE-INDIA',
    decision: 'Refused',
    family: 'evidence',
    reason: 'source_unavailable',
    bps: null,
    backing: null,
    obligation: null,
    charged: false,
    settlement: null,
    href: null,
    source: 'no reading',
    retiredVaultSet: false,
    proof: 'No transfer exists, and no figure was ever computed to refuse against.',
  },
] as const;

export const notes: readonly NoteRecord[] = [plimB, plimA];
export const noteBySlug = (slug: string): NoteRecord | undefined =>
  notes.find((n) => n.market.toLowerCase() === slug.toLowerCase());

export const site = {
  appHref: '/app',
  repo,
  proofDoc: `${repo}/blob/main/PROOF.md`,
  licence: `${repo}/blob/main/LICENSE`,

  /** A transfer of PLIM-A to a blocked address, reverted by the note: AccountIsBlocked. */
  denial: {
    hash: denial.tx,
    href: txUrl(denial.tx),
    subject: shortAddress(denial.blockedCounterparty),
    status: denial.status,
    decoded: 'AccountIsBlocked',
  },

  /** The note the landing points at. */
  note: {
    id: '0.0.10451856',
    href: `${hashscan}/contract/0.0.10451856`,
  },

  /** The HCS topic every attestation and refusal is written to. It has no admin key. */
  auditTopic: {
    id: '0.0.10451091',
    href: `${hashscan}/topic/0.0.10451091`,
  },

  /** Canonical records on the audit topic, in the current encoding. */
  records: {
    attested: 17,
    refusedShort: 18,
    refusedUnproven: 19,
  },

  /** The settlement that paid for record 17. */
  attestedPayment: {
    id: ATTESTED_PAYMENT,
    href: txUrl(ATTESTED_PAYMENT),
  },

  harnessPr: {
    id: 'hedera-harness #55',
    href: 'https://github.com/hedera-dev/hedera-harness/pull/55',
  },

  device:
    halt && refusedResume && resume
      ? ({ halt: txUrl(halt), refusedResume: txUrl(refusedResume), resume: txUrl(resume) } satisfies DeviceLinks)
      : null,

  /** What the venue asks the note before it books anything, read from the deployment record. */
  venue: {
    preflight: deployment.preflight_evidence.call,
    blocked: deployment.preflight_evidence.toBlockedCounterparty,
    allowed: deployment.preflight_evidence.toAllowedCounterparty,
  },

  holder: '0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a',
  holderHref: `${basescan}/address/0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a`,
} as const;
