import { NoteCard, type CardNote } from '@/components/app/NoteCard';
import { notes, site } from '@/site.config';
import styles from '@/components/app/app.module.css';
import market from './market.module.css';

/**
 * The floor. Two notes, because two notes exist: the one that should clear and the one
 * that must always refuse. Nothing here is padded with invented series.
 */
export default function MarketPage() {
  const cards: CardNote[] = notes.map((n) => ({
    market: n.market,
    name: n.name,
    slug: n.market.toLowerCase(),
    obligation: n.obligation,
    negativeControl: n.negativeControl,
    plannedBackingUsd: n.plannedBackingUsd,
    hederaId: n.hederaId,
    href: n.href,
    recorded: n.recorded,
  }));

  const plimB = notes[0];

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>The market floor</h1>
          <p className={styles.lede}>
            Every note is a room: the plates are the backing read from its vaults, the plane is what it owes. A note
            trades only while the plates stand above the plane.
          </p>
        </div>
      </div>

      <div className={market.floor}>
        {cards.map((c) => (
          <NoteCard key={c.market} note={c} />
        ))}
      </div>

      <div className={market.panels}>
        <section className={styles.panel}>
          <h2>Before a note can trade</h2>
          <ol className={styles.rows}>
            {plimB.lifecycle.map((s) => (
              <li key={s.tx}>
                <span className="k">{s.step}</span>
                <span className="v">
                  <a href={s.href}>{s.result}</a>
                </span>
              </li>
            ))}
            <li>
              <span className="k">Ask placed on the venue</span>
              <span className="v">{plimB.listing.status}</span>
              <span className="sub">{plimB.listing.why}</span>
            </li>
          </ol>
          <p className={styles.panelNote}>
            Every step above is a transaction on Hedera testnet. The last one has not happened, and the reason it has
            not is the product working: the venue will not book a trade it cannot prove.
          </p>
        </section>

        <section className={styles.panel}>
          <h2>Four ways this venue says no</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">coverage_below_floor</span>
              <span className="v">asset</span>
              <span className="sub">A real position, valued under the line. Carries the figure that found it.</span>
            </li>
            <li>
              <span className="k">no_attributable_positions</span>
              <span className="v">asset</span>
              <span className="sub">
                The vaults are registered and the holder holds nothing in them. Also a figure: zero, against what is
                owed.
              </span>
            </li>
            <li>
              <span className="k">source_unavailable</span>
              <span className="v">evidence</span>
              <span className="sub">
                No reading yet, stale data, an unresolved vault, sources that disagree. Never a figure.
              </span>
            </li>
            <li>
              <span className="k">{site.denial.decoded}</span>
              <span className="v">
                <a href={site.denial.href}>{site.denial.status}</a>
              </span>
              <span className="sub">
                The note refusing a blacklisted counterparty, on chain. A compliance denial, not a coverage refusal.
              </span>
            </li>
          </ul>
        </section>

        <section className={styles.panel}>
          <h2>What the venue asks first</h2>
          <ul className={styles.rows}>
            <li>
              <span className="k">To a blocked counterparty</span>
              <span className="v">{String(site.venue.blocked.status)}</span>
              <span className="sub">
                EIP-1066 {site.venue.blocked.eip1066Code} · {site.venue.blocked.decoded} {site.venue.blocked.reasonCode}
              </span>
            </li>
            <li>
              <span className="k">To a cleared counterparty</span>
              <span className="v">{String(site.venue.allowed.status)}</span>
              <span className="sub">
                EIP-1066 {site.venue.allowed.eip1066Code} · no reason code
              </span>
            </li>
          </ul>
          <p className={styles.panelNote}>
            {site.venue.preflight} — a read, not a trade. The venue never books a match the note would revert, so a
            refusal costs the taker nothing.
          </p>
        </section>
      </div>
    </>
  );
}
