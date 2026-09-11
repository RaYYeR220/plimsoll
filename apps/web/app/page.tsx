import { Hero } from '@/components/Hero';
import { Strata } from '@/components/Strata';
import { Closing, Footer, Problem, Refusal, Register } from '@/components/Story';
import { site } from '@/site.config';

export default function Home() {
  return (
    <>
      <main>
        <Hero repoHref={site.repo} />
        <Problem />
        <Strata device={site.device} proofDoc={site.proofDoc} />
        <Refusal />
        <Register />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
