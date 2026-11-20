import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TEST_TONE_PROCESSOR, testToneWorkletUrl } from '../audio/test-tone';
import { App } from './App';
import { setDebug } from './debug';
import './styles.css';

setDebug({ workletUrl: testToneWorkletUrl, processorName: TEST_TONE_PROCESSOR });

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
