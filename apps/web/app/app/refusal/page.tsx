import { NoteHero } from '@/components/app/NoteHero';
import { auditRecords, notes, site } from '@/site.config';
import styles from '@/components/app/app.module.css';
import screens from '../screens.module.css';

/**
 * Three refusals that are never the same thing. Only the compliance denial exists on
 * chain as a reverted transaction today, and it is not borrowed to stand for the others.
 */
export default function RefusalPage() {
  const [plimB, plimA] = notes;
  const fixtureShort = auditRecords.find((r) => r.seq === 23);
  const evidence = auditRecords.find((r) => r.family === 'evidence');

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>How a refusal looks</h1>
          <p className={styles.lede}>
            A venue can say no for three unrelated reasons, and collapsing them into one red banner is how a market
            lies to somebody. Each one below keeps its own words, its own reason code, and its own evidence.
          </p>
        </div>
      </div>

      <NoteHero
        obligation={plimB.obligation}
        recorded={plimB.recorded}
        demonstrated={`PLIM-B as CoverageOracle read it on ${plimB.oracle.readOn}: its last attestation has expired, so there is no figure to refuse against.`}
        negativeControl={plimB.negativeControl}
        plannedBackingUsd={plimB.plannedBackingUsd}
      />

      <div className={`${screens.grid} ${screens.gridTight}`}>
        <section className={styles.panel} data-family="asset">
          <h2>The note refused a counterparty</h2>
          <p className={styles.panelNote}>
            On chain, today. A transfer of PLIM-A reached a counterparty on the note's block list and the note reverted
            it. This is a compliance denial: it says nothing about coverage, and it is not the coverage circuit breaker.
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

        <section className={styles.panel} data-family="asset">
          <h2>The backing came up short</h2>
          <p className={styles.panelNote}>
            A finding about the note: the position is real and it is under the line. It always carries a figure, because
            the figure is the finding — and it names both amounts, since $15 against $1,000,000 and an empty wallet both
            round to 0.00%.
          </p>
          <ul className={styles.rows}>
            <li>
              <span className="k">Reason</span>
              <span className="v">coverage_below_floor</span>
            </li>
            <li>
              <span className="k">From the notes’ real backing</span>
              <span className="v">Not yet</span>
              <span className="sub">
                The vault sets are registered, but no reading of the notes’ Base positions has been attested or refused
                yet. Nothing on this page pretends otherwise.
              </span>
            </li>
            {fixtureShort && (
              <li>
                <span className="k">
                  <a href={site.auditTopic.href}>Record {fixtureShort.seq}</a>
                </span>
                <span className="v">
                  {fixtureShort.note} · {fixtureShort.bps !== null ? (fixtureShort.bps / 100).toFixed(2) : '0.00'}%
                </span>
                <span className="sub">
                  {fixtureShort.backing} against {fixtureShort.obligation}, refused and not charged. The shape of the
                  finding is right; the $15 behind it is fixture backing, against the vault set that has since been
                  replaced.
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
                The oracle reads {plimA.market} as {plimA.oracle.reason} and {plimB.market} as {plimB.oracle.reason}.
                Both are evidence refusals, and neither carries a figure.
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

        <section className={`${styles.panel} ${screens.wide}`}>
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
