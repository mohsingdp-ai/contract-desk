import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/standard.css';
import '@fontsource/red-hat-mono/400.css';
import '@fontsource/red-hat-mono/500.css';
import '@fontsource/red-hat-mono/600.css';
import './styles.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
