import { createRoot } from 'react-dom/client';
import './index.css';
import './components/velxio-components/IC74HC595';
import './components/velxio-components/LogicGateElements';
import './components/velxio-components/TransistorElements';
import './components/velxio-components/OpAmpElements';
import './components/velxio-components/PowerElements';
import './components/velxio-components/DiodeElements';
import './components/velxio-components/RelayElements';
import './components/velxio-components/LogicICElements';
import './components/velxio-components/FlipFlopElements';
import './components/velxio-components/RaspberryPi3Element';
import './components/velxio-components/Bmp280Element';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
