import { Seo } from '@/components/Seo'
import { seo } from '@/seo'
import { ArrowDownRight, ArrowRight, CalendarDays, MapPin, Plus, Radio } from 'lucide-react'
import './landing.css'

const features = [
  { title: 'Find a game', text: 'Browse real sessions by date, area, format and skill level.', to: '/games', Icon: Radio },
  { title: 'Explore courts', text: 'Search mapped courts near you or browse verified Pittsburgh booking links.', to: '/courts', Icon: MapPin },
  { title: 'Make a plan', text: 'Invite your group, track RSVPs and add confirmed sessions to your calendar.', to: '/rallies?create=1', Icon: CalendarDays },
]

export default function Home() {
  return (
    <main className="tennis-landing" data-testid="static-landing">
      <Seo {...seo} path="/" />
      <a className="tennis-skip" href="#tennis-heading">Skip to content</a>
      <header className="tennis-frame tennis-header">
        <a href="/" className="tennis-wordmark" aria-label="RallyCircle home">
          <span className="tennis-mark" aria-hidden="true" /> RallyCircle
        </a>
        <nav aria-label="Public navigation">
          <a href="#how-it-works" className="tennis-nav-guide">How it works</a>
          <a href="/dashboard" className="tennis-account">My dashboard <ArrowDownRight size={16} absoluteStrokeWidth aria-hidden /></a>
        </nav>
      </header>

      <section className="tennis-frame tennis-hero" aria-labelledby="tennis-heading">
        <div className="tennis-intro">
          <p className="tennis-eyebrow">Find your next hit</p>
          <h1 id="tennis-heading" tabIndex={-1}>Find players.<br /><span>Play tennis.</span></h1>
          <p>Join a nearby game, invite your hitting partners, and keep score together.</p>
          <div className="tennis-actions">
            <a className="tennis-primary" href="/games">Find a game <ArrowRight size={19} absoluteStrokeWidth aria-hidden /></a>
            <a className="tennis-secondary" href="/rallies?create=1"><Plus size={18} absoluteStrokeWidth aria-hidden /> Create a rally</a>
            <a className="tennis-secondary" href="/courts"><MapPin size={18} absoluteStrokeWidth aria-hidden /> Explore courts</a>
          </div>
        </div>
        <div className="tennis-art">
          <img
            src="/images/rallycircle-court-800.webp"
            srcSet="/images/rallycircle-court-480.webp 480w, /images/rallycircle-court-800.webp 800w, /images/rallycircle-court-1120.webp 1120w"
            sizes="(max-width: 760px) calc(100vw - 2rem), (max-width: 1392px) 47vw, 660px"
            width={800}
            height={533}
            alt=""
            fetchPriority="high"
          />
        </div>
      </section>

      <section id="how-it-works" className="tennis-frame tennis-features" aria-labelledby="tennis-features-heading">
        <h2 id="tennis-features-heading">From the group chat to the court.</h2>
        <ul>
          {features.map(({ title, text, to, Icon }) => (
            <li key={title}>
              <a href={to}><Icon size={21} absoluteStrokeWidth aria-hidden /><h3>{title}</h3><p>{text}</p><ArrowRight className="tennis-feature-arrow" size={20} absoluteStrokeWidth aria-hidden /></a>
            </li>
          ))}
        </ul>
      </section>

      <section className="tennis-frame tennis-matchday" aria-labelledby="tennis-matchday-heading">
        <div>
          <h2 id="tennis-matchday-heading">Play it through.</h2>
          <p>Keep the singles or doubles score as you play. After the match, recorded players can confirm or dispute the result from the session scoreboard.</p>
        </div>
        <a className="tennis-secondary" href="/dashboard">Open dashboard <ArrowRight size={18} absoluteStrokeWidth aria-hidden /></a>
      </section>
      <footer className="tennis-frame tennis-footer">
        <a href="/" className="tennis-wordmark">RallyCircle</a>
        <a href="#how-it-works">How it works</a>
        <a href="/privacy">Privacy and help</a>
      </footer>
    </main>
  )
}
