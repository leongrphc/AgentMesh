import type { TestReport } from "../src/core/contracts.js";

const statusLabels = { passed: "Başarılı", failed: "Başarısız", not_run: "Çalıştırılmadı" };

/**
 * AgentMesh's own test run (when the project has a test command) is evidence and comes first;
 * everything else is what the agent says it ran, and is labelled as such.
 */
export function TestReports({ reports, stale = false }: { reports?: TestReport[]; stale?: boolean }) {
  const verified = reports?.filter((report) => report.source === "agentmesh") ?? [];
  const claimed = reports?.filter((report) => report.source !== "agentmesh") ?? [];
  const item = (report: TestReport, index: number) => <li key={index} className={report.source === "agentmesh" ? "verified" : ""}>
    <div className="test-report-heading">
      <strong>{report.name}</strong>
      <span className={`test-report-status ${report.status}`}>{statusLabels[report.status]}</span>
    </div>
    {report.command && <code>{report.command}</code>}
    {report.details && <p>{report.details}</p>}
  </li>;
  return <section className="test-reports" aria-label="Test raporları">
    <h3>Test raporları</h3>
    {stale && <p className="review-warning" role="status">Dosyalar rapordan sonra değişti. Bu sonuçlar güncel değişiklikleri doğrulamaz; incelemeyi yenilemek testleri tekrar çalıştırmaz.</p>}
    {!!verified.length && <><p className="verified-label">Doğrulandı · AgentMesh bu komutu görevin çalışma alanında kendisi çalıştırdı.</p><ul>{verified.map(item)}</ul></>}
    {!!claimed.length && <><p>Ajanın bildirdiği sonuçlar; AgentMesh bunları bağımsız olarak çalıştırmadı.</p><ul>{claimed.map(item)}</ul></>}
    {!reports?.length && <p>Test raporu yok. Ajanlar → Proje ayarları bölümünden bir test komutu tanımlarsanız AgentMesh her görevden sonra testleri kendisi çalıştırır.</p>}
  </section>;
}
