import type { TestReport } from "../src/core/contracts.js";

const statusLabels = { passed: "Başarılı", failed: "Başarısız", not_run: "Çalıştırılmadı" };

export function TestReports({ reports, stale = false }: { reports?: TestReport[]; stale?: boolean }) {
  return <section className="test-reports" aria-label="Test raporları">
    <h3>Test raporları</h3>
    <p>Ajanın bildirdiği sonuçlardır; AgentMesh bu testleri bağımsız olarak çalıştırmadı.</p>
    {stale && <p className="review-warning" role="status">Dosyalar rapordan sonra değişti. Bu sonuçlar güncel değişiklikleri doğrulamaz; incelemeyi yenilemek testleri tekrar çalıştırmaz.</p>}
    {!reports?.length ? <p>Yapılandırılmış test raporu yok.</p> : <ul>{reports.map((report, index) => <li key={index}>
      <div className="test-report-heading"><strong>{report.name}</strong><span className={`test-report-status ${report.status}`}>{statusLabels[report.status]}</span></div>
      {report.command && <code>{report.command}</code>}
      {report.details && <p>{report.details}</p>}
    </li>)}</ul>}
  </section>;
}
