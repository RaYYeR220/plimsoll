import { NoteHero } from '@/components/app/NoteHero';
import { formatBps } from '@/lib/coverage-state';
import { auditRecords, notes, site } from '@/site.config';
import styles from '@/components/app/app.module.css';
import screens from '../screens.module.css';

const utc = (iso: string) => `${iso.slice(11, 19)} UTC`;

/**
 * Refusals that are never the same thing. Two are reverted transactions on chain — the
 * note refusing a counterparty, and the oracle refusing an attestation it had already
 * counted — and neither is borrowed to stand for a coverage finding.
 */
export default function RefusalPage() {
  const [plimB, plimA] = notes;
  const last = plimB.lastAttestation;
  const replay = site.staleReplay;
  const liveShort = auditRecords.find((r) => r.live && r.reason === 'coverage_below_floor');
  const evidence = auditRecords.find((r) => r.seq === 19);

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>How a refusal looks</h1>
          <p className={styles.lede}>
            A venue can say no for unrelated reasons, and collapsing them into one red banner is how a market lies to
            somebody. Each one below keeps its own words, its own reason code, and its own evidence.
          </p>
        </div>
      </div>

      <NoteHero
        obligation={plimB.obligation}
        recorded={plimB.recorded}
        demonstrated={
          last
            ? `PLIM-B as CoverageOracle reads it now: its last live attestation read ${formatBps(last.coverageBps)} at ${utc(last.acceptedAt)} and expired at ${utc(last.expiresAt)}, so there is no figure until the next one.`
            : `PLIM-B as CoverageOracle reads it now: its last attestation has expired, so there is no figure to refuse against.`
        }
        negativeControl={plimB.negativeControl}
        fundedBackingUsd={plimB.positions?.totalUsd}
      />

      <div className={`${screens.grid} ${screens.gridTight}`}>
        <section className={styles.panel} data-family="asset">
          <h2>The note refused a counterparty</h2>
          <p className={styles.panelNote}>
            On chain. A transfer of PLIM-A reached a counterparty on the note's block list and the note reverted it. This
            is a compliance denial: it says nothing about coverage, and it is not the coverage circuit breaker.
          </p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Result</span>
              <span className="v">{site.denial.status}</span>
            </li>
            <li>
              <span className="k">Error</span>
              <span className="v">
                {site.denial.decoded}({site.denial.subject})
              </span>
              <span className="sub">
                The error is declared with no arguments, and the revert appends the address it refused.
              </span>
            </li>
            <li>
              <span className="k">Transaction</span>
              <span className="v">
                <a href={site.denial.href}>Open on HashScan</a>
              </span>
            </li>
          </ul>
        </section>

        <section className={styles.panel} data-family="evidence">
          <h2>The oracle refused a replayed attestation</h2>
          <p className={styles.panelNote}>
            On chain. A real signed attestation of PLIM-B was accepted, and the same attestation sent again two seconds
            later was reverted. The oracle only takes an attestation newer than the last one it counted. This is not a
            compliance denial and not a coverage finding: it is the oracle declining evidence it already holds.
          </p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Result</span>
              <span className="v">{replay.status}</span>
            </li>
            <li>
              <span className="k">Error</span>
              <span className="v">{replay.error}(provided, floor)</span>
              <span className="sub">
                Both are {utc(replay.provided)}: the attestation offered was no newer than the one already accepted.
              </span>
            </li>
            <li>
              <span className="k">Transaction</span>
              <span className="v">
                <a href={replay.href}>Open on HashScan</a>
              </span>
            </li>
            {last && (
              <li>
                <span className="k">The original</span>
                <span className="v">
                  <a href={last.href}>Accepted {utc(last.acceptedAt)}</a>
                </span>
              </li>
            )}
          </ul>
        </section>

        <section className={styles.panel} data-family="asset">
          <h2>The backing came up short</h2>
          <p className={styles.panelNote}>
            A finding about the note: the position is real and it is under the line. It always carries a figure, because
            the figure is the finding — and it names both amounts, since $1 against $1,000,000 and an empty wallet both
            round to 0.00%.
          </p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Reason</span>
              <span className="v">coverage_below_floor</span>
            </li>
            {liveShort && (
              <li>
                <span className="k">
                  <a href={site.auditTopic.href}>Record {liveShort.seq}</a>
                </span>
                <span className="v">
                  {liveShort.note} · {liveShort.bps !== null ? (liveShort.bps / 100).toFixed(2) : '0.00'}%
                </span>
                <span className="sub">
                  {liveShort.backing} against {liveShort.obligation}, refused live from the note’s real position on Base,
                  and not charged. The negative control, doing its job.
                </span>
              </li>
            )}
          </ul>
        </section>

        <section className={styles.panel} data-family="evidence">
          <h2>We could not prove it either way</h2>
          <p className={styles.panelNote}>
            A statement about our own evidence, not about the note. It never carries a figure, whether the true position
            is high or low — a number here would be a guess wearing a signature.
          </p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Reasons</span>
              <span className="v">source_unavailable</span>
              <span className="sub">
                Also stale data, an unresolved vault, sources that disagree, and on chain an expired or missing
                attestation.
              </span>
            </li>
            <li>
              <span className="k">Both notes, read {plimB.oracle.readOn}</span>
              <span className="v">This one</span>
              <span className="sub">
                The oracle reads {plimB.market} as {plimB.oracle.reason}, because its live attestation has lapsed, and{' '}
                {plimA.market} as {plimA.oracle.reason}, because the attestor refused it rather than attest it. Neither
                carries a figure.
              </span>
            </li>
            {evidence && (
              <li>
                <span className="k">
                  <a href={site.auditTopic.href}>Record {evidence.seq}</a>
                </span>
                <span className="v">{evidence.note}</span>
                <span className="sub">Refused with no figure at all, and not charged.</span>
              </li>
            )}
          </ul>
        </section>

        <section className={`${styles.panel} ${screens.span2}`}>
          <h2>A refusal that costs nothing</h2>
          <p className={styles.panelNote}>
            The attestation service is paid per answer, and it charges only for an answer it can stand behind. A refusal
            returns before settlement is ever called, so the buyer's signed transfer is never submitted. The proof of a
            refusal is a transaction that does not exist, and the mirror node is what lets a stranger check that an
            absence is really an absence.
          </p>
          <ul className={styles.rows}>
            {auditRecords.map((r) => (
              <li key={r.seq}>
                <span className="k">
                  Record {r.seq} · {r.note}
                  {r.live ? ' · live' : ''}
                </span>
                <span className="v">
                  {r.charged && r.href ? <a href={r.href}>Charged once</a> : 'Not charged'}
                </span>
                <span className="sub">{r.proof}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
