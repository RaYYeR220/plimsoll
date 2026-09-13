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
import backingPlan from '../../packages/backing/backing-plan.json';
import type { LifecycleStep, NoteRecord, PositionReading, VaultLeg } from './lib/notes';

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

/* ── the backing ─────────────────────────────────────────────────────────
   The vaults and the plan come from the file the backing package generates. The two
   notes' sets are disjoint: a position backs exactly one note. */

type PlanLeg = {
  key: string;
  name: string;
  protocol: string;
  address: string;
  asset: string;
  planned: number | string;
  min?: number;
  max?: number;
};
const planNotes = backingPlan.notes as Record<string, { legs: PlanLeg[] }>;

/**
 * The holder's positions, read from each vault as convertToAssets(balanceOf(holder)) at
 * one Base block. A reading, not an attestation: the vaults accrue, so it is pinned to its
 * block and replaced when the attestation lands, never left to look current.
 */
const POSITIONS = {
  chain: 'Base',
  block: 51_243_788,
  readAt: '2026-09-13T05:22:03Z',
  usdc: { morpho: '8.000008', aave: '3.000002', spark: '3.000002', fluid: '1.000000' } as Record<string, string>,
};

const MICRO = 1_000_000n;
const toMicro = (usdc: string): bigint => {
  const [whole, frac = ''] = usdc.split('.');
  return BigInt(whole) * MICRO + BigInt((frac + '000000').slice(0, 6));
};
const fromMicro = (micro: bigint): string => `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, '0')}`;

function planFor(market: string): VaultLeg[] {
  const legs = planNotes[market]?.legs ?? [];
  return legs.map((l) => ({
    key: l.key,
    name: l.name,
    protocol: l.protocol,
    address: l.address,
    asset: l.asset,
    planned: typeof l.planned === 'number' ? l.planned : 'rest',
    min: l.min,
    max: l.max,
    funded: POSITIONS.usdc[l.key] ?? null,
    href: `${basescan}/address/${l.address}`,
  }));
}

function positionsFor(market: string): PositionReading | null {
  const legs = planFor(market);
  if (legs.length === 0 || legs.some((l) => l.funded === null)) return null;
  const total = legs.reduce((sum, l) => sum + toMicro(l.funded as string), 0n);
  return {
    chain: POSITIONS.chain,
    block: POSITIONS.block,
    readAt: POSITIONS.readAt,
    totalUsdc: fromMicro(total),
    totalUsd: Number(total) / 1e6,
  };
}

/**
 * What the plan does when it is tested, measured on a fork of Base before the deposits
 * were made. The real positions are read separately above.
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

/* ── the live attestation ───────────────────────────────────────────────
   Not yet in the deployment record, so it is kept here, once. Each value was checked
   on the mirror node and against the attestor's own receipt:
   - accepted: CoverageOracle, SUCCESS at 05:28:38 UTC, coverageBps 14000, asOfBlock
     51,243,979, the registered vault set; the signed expiry is 1789277610, 05:33:30 UTC
   - replay:   the same attestation two seconds later, CONTRACT_REVERT_EXECUTED,
     StaleAttestation(uint64 provided, uint64 floor) with both at 05:28:30 UTC
   - anchored: HCS record 25, paid by the settlement below */

const LIVE_ATTESTATION_TX = '0x2fdaa9805fdf9a2447250dbab60f27c776d24858f7cbdec82de6a2203401d3aa';
const STALE_REPLAY_TX = '0xa33b583902b90405112e74f0626063be3b6212be143d06cb847ff15ea68191c8';
const LIVE_PAYMENT = '0.0.7162784@1789277301.435133461';

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
  /* coverageOf(noteId) on CoverageOracle, read 2026-09-13 10:02 UTC: 0 bps, Unproven,
     AttestationExpired — the live attestation below lapsed at 05:33:30 UTC. */
  oracle: { verdict: 'Unproven', reason: 'AttestationExpired', readOn: '2026-09-13 10:02 UTC' },
  recorded: { family: 'evidence', reason: 'attestation-expired' },
  recordSeqs: [25, 22],
  lastAttestation: {
    tx: LIVE_ATTESTATION_TX,
    href: txUrl(LIVE_ATTESTATION_TX),
    acceptedAt: '2026-09-13T05:28:38Z',
    coverageBps: 14_000,
    thresholdBps: 10_000,
    loadLine: 'clear · Covered',
    asOfBlock: 51_243_979,
    expiresAt: '2026-09-13T05:33:30Z',
    record: 25,
  },
  plan: planFor('PLIM-B'),
  positions: positionsFor('PLIM-B'),
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
    {
      step: 'Live attestation accepted, 140.00%',
      tx: LIVE_ATTESTATION_TX,
      href: txUrl(LIVE_ATTESTATION_TX),
      result: 'SUCCESS',
    },
  ],
  /* The deployment record's own reason predates setVaultSet and still calls the set
     unfinished, so it is restated here from what the chain says now. */
  listing: {
    status: noteB.listing.status,
    why: 'placeAsk calls LoadLine.requireClear(PLIM-B). It read clear — Covered at 140.00% — while the live attestation accepted at 05:28 UTC was fresh. That attestation expired at 05:33:30 UTC, and an expired attestation is not evidence, so the venue refuses again until the next one.',
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
  /* coverageOf(noteId) on CoverageOracle, read 2026-09-13 10:02 UTC: 0 bps, Unproven,
     NoAttestation — the attestor refused it live (record 26), so nothing was submitted. */
  oracle: { verdict: 'Unproven', reason: 'NoAttestation', readOn: '2026-09-13 10:02 UTC' },
  recorded: { family: 'evidence', reason: 'no-attestation' },
  recordSeqs: [26, 23],
  plan: planFor('PLIM-A'),
  /* One dollar of USDC against a $1,000,000 obligation: a 0.00% that is not an empty wallet. */
  positions: positionsFor('PLIM-A'),
  lifecycle: [],
  listing: {
    status: 'not listed',
    why: 'The negative control is never meant to clear: a $1,000,000 obligation against one dollar of backing.',
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
 * 25 and 26 are live: read from the notes' registered vaults on Base, and they are the
 * notes' real history. 22 to 24 are fixture records — 22 and 23 name the real notes, but
 * their positions are invented and their vault-set hashes are the retired placeholders.
 * 17 to 19 are the service's own test notes. Each record declares its own feed.
 */
export const auditRecords = [
  {
    seq: 25,
    note: 'PLIM-B',
    decision: 'Attested',
    family: null,
    reason: null,
    bps: 14_000,
    backing: '$14.000018',
    obligation: '$10.00',
    charged: true,
    settlement: LIVE_PAYMENT,
    href: txUrl(LIVE_PAYMENT),
    live: true,
    source: 'live, Base block 51,243,979',
    retiredVaultSet: false,
    proof: 'Charged once, for a live reading of the registered vaults: the first attestation of this note’s real backing.',
  },
  {
    seq: 26,
    note: 'PLIM-A',
    decision: 'Refused',
    family: 'asset',
    reason: 'coverage_below_floor',
    bps: 0,
    backing: '$1.000000',
    obligation: '$1,000,000.00',
    charged: false,
    settlement: null,
    href: null,
    live: true,
    source: 'live, Base block 51,244,012',
    retiredVaultSet: false,
    proof: 'No transfer exists. A live 0.00% that is not an empty wallet: the amounts are the finding.',
  },
  {
    seq: 22,
    live: false,
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
    proof: 'No transfer exists. The shape of the finding, on fixture backing.',
    live: false,
  },
  {
    seq: 24,
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
    live: false,
    source: 'fixture, no reading',
    retiredVaultSet: false,
    proof: 'No transfer exists, and no figure was ever computed to refuse against.',
  },
  {
    seq: 17,
    live: false,
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
    live: false,
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
    live: false,
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
    /** Live: PLIM-B attested at 140.00% and charged. */
    attested: 25,
    /** Live: PLIM-A, the negative control, refused as coverage_below_floor and not charged. */
    refusedShort: 26,
    /** The service's own test note, refused with no figure. */
    refusedUnproven: 19,
  },

  /** The settlement that paid for record 25. */
  attestedPayment: {
    id: LIVE_PAYMENT,
    href: txUrl(LIVE_PAYMENT),
  },

  harnessPr: {
    id: 'hedera-harness #55',
    href: 'https://github.com/hedera-dev/hedera-harness/pull/55',
  },

  device:
    halt && refusedResume && resume
      ? ({ halt: txUrl(halt), refusedResume: txUrl(refusedResume), resume: txUrl(resume) } satisfies DeviceLinks)
      : null,

  /**
   * The oracle refusing a real signed attestation it had already counted: the same
   * attestation of PLIM-B, replayed two seconds after it was accepted.
   */
  staleReplay: {
    tx: STALE_REPLAY_TX,
    href: txUrl(STALE_REPLAY_TX),
    at: '2026-09-13T05:28:40Z',
    status: 'CONTRACT_REVERT_EXECUTED',
    error: 'StaleAttestation',
    provided: '2026-09-13T05:28:30Z',
    floor: '2026-09-13T05:28:30Z',
  },

  /** What the venue asks the note before it books anything, read from the deployment record. */
  venue: {
    preflight: deployment.preflight_evidence.call,
    blocked: deployment.preflight_evidence.toBlockedCounterparty,
    allowed: deployment.preflight_evidence.toAllowedCounterparty,
  },

  holder: '0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a',
  holderHref: `${basescan}/address/0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a`,
} as const;
