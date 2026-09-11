import { site } from '@/site.config';
import styles from './Story.module.css';

const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-8)}`;

export function Problem() {
  return (
    <section className={styles.section} aria-labelledby="problem-title">
      <h2 className={styles.title} id="problem-title">
        A number someone typed in
      </h2>
      <p className={styles.lead}>
        Every tokenised asset prices itself with a number its issuer typed in: the size of the reserve, the value of
        the collateral, the ratio that says the note is safe. The buyer cannot see behind it, the market trades against
        it, and nothing stops it being wrong the morning after it was entered. Plimsoll takes that number out of the
        issuer’s hands. Coverage is read from the vault positions themselves, signed by an attestor, and held against a
        line that moves only when a person approves it on a device. When coverage comes up short, the network refuses
        to move the money.
      </p>
    </section>
  );
}

export function Refusal() {
  const { attested, refusedShort, refusedUnproven } = site.records;
  return (
    <section className={styles.section} id="refusal" aria-labelledby="refusal-title">
      <h2 className={styles.title} id="refusal-title">
        The refusal is on the record
      </h2>

      <div className={styles.entries}>
        <article className={styles.entry} aria-labelledby="denial-title">
          <h3 id="denial-title">The note turned a transfer away</h3>
          <p>
            At 02:11 UTC on 10 September 2026, a transfer of PLIM-A to an address on the note’s block list reached
            Hedera testnet. The note reverted it, and the revert says what it refused: the error, and the address,
            written into the transaction itself.
          </p>
          <div className={`${styles.record} plate-outline`} data-lamp="arc">
            <p className={styles.status}>CONTRACT_REVERT_EXECUTED</p>
            <p className={styles.reason}>AccountIsBlocked({site.denial.subject})</p>
            <p className={styles.links}>
              <a href={site.denial.href}>Open the transaction on HashScan</a>
            </p>
          </div>
        </article>

        <article className={styles.entry} aria-labelledby="uncharged-title">
          <h3 id="uncharged-title">The refusal nobody paid for</h3>
          <p>
            The attestation service is paid per answer over x402, and it charges only for an answer it can stand behind.
            Asked about a note covered at 87% against a floor of 100%, it refused, signed the refusal and wrote it to a
            public Hedera topic as record {refusedShort}. The buyer’s payment was authorised and never submitted, so
            there is no transfer to find.
          </p>
          <p>
            Record {attested} is the other outcome: a note that cleared, attested and paid for in one 0.001 HBAR
            transaction. Record {refusedUnproven} is the third: the service could not prove coverage either way, so the
            record carries no number at all.
          </p>
          <div className={`${styles.record} plate-outline`} data-lamp="arc">
            <p className={styles.status}>Record {refusedShort}, refused and not charged</p>
            <p className={styles.reason}>coverage_below_floor</p>
            <p className={styles.links}>
              <a href={site.auditTopic.href}>Read the records on HashScan</a>
              <a href={site.attestedPayment.href}>Open the payment for record {attested}</a>
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

export function Register() {
  const entries = [
    {
      name: 'The refused transfer',
      about: 'A transfer of PLIM-A reverted by the note itself: AccountIsBlocked, with the address it refused.',
      id: shortHash(site.denial.hash),
      href: site.denial.href,
      where: 'HashScan',
    },
    {
      name: 'The note',
      about: 'PLIM-A, Plimsoll Note Series A, issued through Asset Tokenization Studio v8.0.0.',
      id: site.note.id,
      href: site.note.href,
      where: 'HashScan',
    },
    {
      name: 'The audit topic',
      about: 'Every attestation and every refusal, in order. The topic has no admin key, so nobody can change it.',
      id: site.auditTopic.id,
      href: site.auditTopic.href,
      where: 'HashScan',
    },
    {
      name: 'A paid attestation',
      about: `Record ${site.records.attested}: 0.001 HBAR for a coverage reading that cleared, settled in one transaction.`,
      id: site.attestedPayment.id,
      href: site.attestedPayment.href,
      where: 'HashScan',
    },
    {
      name: 'The harness fix',
      about: 'Our pull request that lets Hedera’s harness build and pass its tests on Windows: 197 of 197.',
      id: site.harnessPr.id,
      href: site.harnessPr.href,
      where: 'GitHub',
    },
  ];

  return (
    <section className={styles.section} id="proof" aria-labelledby="proof-title">
      <h2 className={styles.title} id="proof-title">
        Check it yourself
      </h2>
      <p className={styles.intro}>Every link opens a public explorer or repository. None of it needs a wallet.</p>
      <ul className={styles.register}>
        {entries.map((e) => (
          <li key={e.name} className={styles.item}>
            <h3 className={styles.itemName}>{e.name}</h3>
            <p className={styles.itemAbout}>{e.about}</p>
            <p className={styles.itemLink}>
              <a href={e.href}>
                {e.id} <span>on {e.where}</span>
              </a>
            </p>
          </li>
        ))}
      </ul>
      <p className={styles.intro}>
        Contract addresses, test runs and the device transcripts are in <a href={site.proofDoc}>PROOF.md</a>.
      </p>
    </section>
  );
}

export function Closing() {
  return (
    <section className={`${styles.section} ${styles.closing}`} aria-labelledby="closing-title">
      <h2 className={styles.title} id="closing-title">
        Issue only what the room holds.
      </h2>
      <p className={styles.lead}>
        The note, its market, the attestation service and the device authority run on Hedera testnet, and all of it is
        open source.
      </p>
      <div className={styles.actions}>
        <a className="plate-button" href={site.appHref}>
          Open the app
        </a>
        <a className="plate-button plate-button--quiet" href={site.repo}>
          Read the source
        </a>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <p className={styles.footMark}>Plimsoll</p>
      <ul className={styles.footLinks}>
        <li>
          <a href={site.repo}>Source code</a>
        </li>
        <li>
          <a href={site.proofDoc}>Proof</a>
        </li>
        <li>
          <a href={site.licence}>MIT licence</a>
        </li>
      </ul>
      <p>Runs on Hedera testnet. Not audited.</p>
    </footer>
  );
}
