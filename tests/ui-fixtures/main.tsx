// Test-only entry. The production router never imports this file.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Navigation from '../../src/components/Navigation'
import RalliesPage from '../../src/pages/(app)/(protected)/rallies'
import DashboardPage from '../../src/pages/(app)/(protected)/dashboard'
import GamesPage from '../../src/pages/(app)/(protected)/games'
import Home from '../../src/pages/index'
import { ToastProvider } from '../../src/components/ui/Toast'
import '../../src/styles.css'

const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'rallies'
const entry = view === 'dashboard' ? '/dashboard' : view === 'games' ? '/games' : params.has('detail') ? '/rallies?session=fixture-doubles' : '/rallies'
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[entry]}>
    <ToastProvider>
      {view === 'landing' ? <Home /> : <><Navigation /><main id="app-content">{view === 'dashboard' ? <DashboardPage /> : view === 'games' ? <GamesPage /> : <RalliesPage />}</main></>}
    </ToastProvider>
  </MemoryRouter>,
)
