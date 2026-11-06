// This separate view keeps the main React tree mounted while its host panel is hidden.
declare const webviewApi: {
  postMessage(message: unknown): Promise<{ ok: boolean; label?: string; error?: string }>;
  onMessage(handler: (event: { message?: { type?: string; label?: string } }) => void): void;
};
const button = document.getElementById('restore') as HTMLButtonElement;
let sequence = 0;
const request = (action: string) => webviewApi.postMessage({ protocolVersion: 1, requestId: `mini:${Date.now()}:${++sequence}`, action });
function setLabel(label?: string) { if (label) { button.title = label; button.setAttribute('aria-label', label); } }
webviewApi.onMessage(event => { if (event.message?.type === 'restoreLabel') setLabel(event.message.label); });
void request('miniReady').then(reply => setLabel(reply.label)).catch(() => {});
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const reply = await request('restorePanel');
    if (!reply.ok) throw new Error(reply.error || button.title);
  } catch (error) { button.title = (error as Error).message; }
  finally { button.disabled = false; }
});
export {};
