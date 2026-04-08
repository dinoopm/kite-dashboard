import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Portfolio from './pages/Portfolio'
import Instrument from './pages/Instrument'
import Navbar from './components/Navbar'

function App() {
  return (
    <BrowserRouter>
      <div style={{ maxWidth: '1600px', width: '95%', margin: '0 auto', padding: '2rem 1rem' }}>
        <Navbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/instrument/:token" element={<Instrument />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
