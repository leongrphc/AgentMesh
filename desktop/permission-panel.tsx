import type { DesktopAPI, DesktopState } from "../src/desktop/contracts.js";

export function PermissionPanel({ state, api, pending, act }: {
  state: DesktopState;
  api: DesktopAPI;
  pending: boolean;
  act: (action: () => Promise<unknown>) => void;
}) {
  if (!state.permissions.length) return null;
  return <section className="permission-panel" aria-label="Bekleyen izinler">
    <h2>Ajan onayınızı bekliyor <span>{state.permissions.length}</span></h2>
    {state.permissions.map((request) => <article key={request.id}>
      <div className="permission-title">
        <b>{request.taskId}</b>
        <span>
          {request.provider} · {request.kind === "command" ? "Komut izni" : "Dosya izni"} ·{" "}
          {new Date(request.expiresAt).toLocaleTimeString("tr-TR")} tarihine kadar
        </span>
      </div>
      <pre>{request.description}</pre>
      <div className="permission-actions">
        <small>Hassas değerler maskelenmiş olabilir. Karar yalnızca bu istek için geçerlidir.</small>
        <button disabled={pending}
          onClick={() => act(() => api.decidePermission(request.id, request.executionId, request.digest, "deny"))}>Reddet</button>
        <button className="primary" disabled={pending}
          onClick={() => act(() => api.decidePermission(request.id, request.executionId, request.digest, "allow_once"))}>Bir kez izin ver</button>
      </div>
    </article>)}
  </section>;
}
