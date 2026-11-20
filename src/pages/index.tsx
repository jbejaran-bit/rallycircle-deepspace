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
      <header className="tennis-frame tennis-header">
        <a href="/" className="tennis-wordmark" aria-label="RallyCircle home">
          <span className="tennis-mark" aria-hidden="true" /> RallyCircle
        </a>
        <nav aria-label="Public navigation">
          <a href="#how-it-works" className="tennis-nav-guide">How it works</a>
          <a href="/dashboard" className="tennis-account">My dashboard <ArrowDownRight size={16} aria-hidden /></a>
        </nav>
      </header>

      <section className="tennis-frame tennis-hero" aria-labelledby="tennis-heading">
        <div className="tennis-intro">
          <h1 id="tennis-heading">Good tennis<br />starts <em>here.</em></h1>
          <p>Find a court, get your players together, and keep track of the match from first serve to final score.</p>
          <div className="tennis-actions">
            <a className="tennis-primary" href="/games">Find a game <ArrowRight size={19} aria-hidden /></a>
            <a className="tennis-secondary" href="/rallies?create=1"><Plus size={18} aria-hidden /> Create a rally</a>
          </div>
        </div>
        <div className="tennis-art" aria-hidden="true">
          <div className="tennis-court">
            <i className="tennis-baseline tennis-baseline-start" />
            <i className="tennis-baseline tennis-baseline-end" />
            <i className="tennis-singles" />
            <i className="tennis-service" />
            <i className="tennis-net" />
          </div>
          <div className="tennis-ball" />
        </div>
      </section>

      <section id="how-it-works" className="tennis-frame tennis-features" aria-labelledby="tennis-features-heading">
        <h2 id="tennis-features-heading">From the group chat to the court.</h2>
        <ul>
          {features.map(({ title, text, to, Icon }) => (
            <li key={title}>
              <a href={to}><Icon size={21} aria-hidden /><h3>{title}</h3><p>{text}</p><ArrowRight className="tennis-feature-arrow" size={20} aria-hidden /></a>
            </li>
          ))}
        </ul>
      </section>

      <footer className="tennis-frame tennis-footer">
        <a href="/" className="tennis-wordmark">RallyCircle</a>
        <a href="#how-it-works">How it works</a>
        <a href="/privacy">Privacy and help</a>
      </footer>
    </main>
  )
}
