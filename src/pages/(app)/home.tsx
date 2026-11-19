import { Navigate } from 'react-router-dom'

// Keep old scaffold links functional; the real signed-in product lives at /rallies.
export default function HomeRedirect() {
  return <Navigate to="/rallies" replace />
}
