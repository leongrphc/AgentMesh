# Sürümlü ortak kararlar

Ortak context, proje içindeki kabul edilmiş gerçekler/kararlardır. Her anahtarın ayrı, 1'den başlayan sürüm geçmişi vardır. Sürüm numarası journal sırasındaki kabul edilmiş `context.updated` olaylarından türetilir; kaynak görev ve zaman damgası korunur. Aynı değer yeniden bildirilirse yeni kaynak da geçmişe eklenir.

Bir ajan mevcut anahtara **farklı** değer önerdiğinde eski değer korunur ve `context.conflict.created` kaydı oluşur. Öneri, kaynak görev ve yayınlama anındaki karşılaştırma sürümüyle saklanır. Bu sürüm, ajanın çalışmaya başladığında okuduğu sürümün kanıtı değildir. Çakışmalar yeni görev dalgalarını durdurur; zaten çalışan görevler devam eder. Çakışma sırasında tamamlanan başka görevler de ayrı öneriler oluşturabilir.

Dosya değiştiren görevin facts/messages sonuçları mevcut digest onayını bekler. Context çakışması, **onaylanan kodun entegrasyonu sonrası** yayınlama sırasında oluşabilir. Kod entegrasyonu ve ortak karar seçimi ayrı işlemlerdir; context kararı Git değişikliklerini geri almaz. Görev tamamlanabilir ama sonraki görevler bekler.

Ortak context sekmesi mevcut değerle öneriyi yan yana gösterir. Kullanıcı:

- Mevcut kararı koruyabilir; bu seçim değerin sürümünü artırmaz.
- Öneriyi kabul edebilir; önerinin kaynak göreviyle yeni sürüm oluşur.
- Farklı bir değer yazabilir; kaynak `@user` olan yeni sürüm oluşur.

Karar isteği çakışma kimliğini ve görülen **güncel** sürümü taşır. Sürüm değişmişse, başka projeye aitse veya çakışma zaten çözülmüşse reddedilir. Çalışan görev varken karar verilemez. Seçim, yeni değer ve çözüm kaydı aynı SQLite transaction'ında kalıcılaşır. Karar vermek ajanları otomatik başlatmaz; bütün çakışmalar çözüldükten sonra ayrıca Başlat gerekir. Tüm projenin durması muhafazakâr ilk politikadır; anahtar/görev bazında etki analizi henüz yoktur.

CLI aynı journal ve kontrolleri kullanır:

```powershell
npm run live -- --config agentmesh.config.json --context
npm run live -- --config agentmesh.config.json --resolve-context CONFLICT_ID --revision 1 --choice accept
npm run live -- --config agentmesh.config.json --resolve-context CONFLICT_ID --revision 1 --choice keep
npm run live -- --config agentmesh.config.json --resolve-context CONFLICT_ID --revision 1 --choice custom --value-file karar.txt
```

`karar.txt` UTF-8 olmalı; özel karar en fazla 16.384 karakterdir. `--context` bütün geçmişi ve önerileri gösterir. `--execute` çözülmemiş karar nedeniyle beklerse sonuçtaki `pendingContextDecisions` kimlikleri listelenir ve çıkış kodu 2 olur. Context inceleme ve karar komutları model çağırmaz; ajan çalıştırmak için ayrı `--execute` gerekir.

SQLite `user_version=2`, yeni olay semantiğini tanımayan eski uygulamaların bu veritabanını açmasını engeller. Sürüm 1 açıldığında olaylar silinmeden sürüm 2'ye geçirilir; daha yeni bilinmeyen sürümler reddedilir. Eski `context.updated` olayları replay sırasında sıralı geçmişe dönüşür. Eski tarihlerde yayınlanmış farklı değerler geriye dönük yeni çakışma haline getirilmez. JSONL yalnızca geliştirme/legacy aktarım yoludur; üretim masaüstü ve CLI SQLite kullanır.

Testler: paralel öneriler, yeni görev dalgasının beklemesi, açık tekrar başlatma, stale sürüm, keep/accept/custom, proje kapsamı, snapshot'ın dışarıdan değiştirilememesi, eski journal replay, SQLite v1→v2 geçişi, gelecek sürüm reddi, gerçek Git digest onayı ve CLI çözümü. Electron smoke karşılaştırma ekranını, bekleyen bağımlı görev için Başlat engelini ve kullanıcı kararından sonraki sürümü doğrular.

## Görev context paketleri

Görev tanımındaki isteğe bağlı `contextKeys` ve Yeni görev formundaki context kapsamı aynı politikayı kullanır:

- Alan yoksa tüm kabul edilmiş proje kararları seçilir. İlgisiz görev özetleri eklenmez.
- `contextKeys: ["api.contract"]` yalnızca tam eşleşen anahtarları seçer.
- `contextKeys: []` ek karar seçmez.
- Her durumda doğrudan ve dolaylı bağımlılıkların mevcut özetleri eklenir. Gelecekte üretilecek anahtar için üretici görevi bağımlılıklara ekleyin.

Seçilen anahtar çalıştırma anında yoksa görev model çağrısından ve worktree oluşturmadan önce başarısız olur. Paket en fazla 128 kayıt ve UTF-8 JSON olarak 256 KiB olabilir; sessiz kırpma yapılmaz. Kapsamı daraltın; yalnızca bağımlılık özetleri bile sınırı aşıyorsa görev zincirini bölün. Bunlar byte/kayıt sınırlarıdır, sağlayıcı token limiti değildir. Kaydedilmiş görevin seçim politikasını değiştirmek config drift sayılır; yeni görev kimliği kullanın.

`task.context.prepared` her deneme için executionId, politika sürümü, SHA-256, byte sayısı ve anahtar/sürüm listesini saklar. Değerler yeniden kopyalanmaz; `contextHistory` ile eşleştirilebilir. Görev detayındaki **Hazırlanan context** ve CLI görev raporundaki `contextPackages` bu kayıtları gösterir. Yeniden denemeler ayrı kayıt üretir; eski görevlerde geriye dönük kanıt üretilmez. Bu olay adaptöre gönderilmek üzere hazırlanan girdiyi belgeler, sağlayıcının kabul ettiğini veya modelin okuduğunu kanıtlamaz; hazırlık sonrası iptal/hata olabilir.

Seçim yalnızca yeni context paketini sınırlar. Devam ettirilen native oturum önceki girdileri hatırlayabilir; görev talimatı, inbox mesajları ve çalışma dosyaları ayrı girdilerdir. Bu özellik veri erişimi izolasyonu sağlamaz. Geçmiş ve bekleyen öneriler otomatik pakete eklenmez. Eski sürüm uygulamalar yeni seçim politikasını uygulamaz; bu özellik için güncel uygulama kullanılmalıdır.

Doğrulama: deterministik seçim/hash, dolaylı bağımlılıklar, açık/boş seçim, eksik anahtar, UTF-8 boyut/kayıt sınırları, config drift, mutable girdi, tekrar deneme ve journal replay testleri. Electron smoke form → IPC → görev → bağımlılık paketi ve sürüm detayını doğrular; gerçek model çağırmaz.

Açık kapsam: büyük geçmişler için sayfalama/retention ve anahtar bazında çakışma etki analizi.

## Masaüstünde geçmişi sayfalama

Sürüm geçmişi, ilgili anahtarın ayrıntısı açıldığında yüklenir. Her sayfa en fazla 20 kaydı en yeniden eskiye gösterir; **Daha eski**, **Daha yeni** ve **En yeni sürümler** düğmeleriyle gezinilir. Yeni kararlar okunmakta olan eski sayfanın aralığını değiştirmez. İstek `before` sürümünü dışlayan bir üst sınır kullanır; yeni sürümleri görmek için en yeni sayfayı yeniden açın. Hatalı okumalar ekranda gösterilir ve tekrar denenebilir.

Masaüstü durum yayınlarında `contextHistory` boş bırakılır; tarihçe ayrı `contextHistory(projectId, workspaceRoot, key, before?)` IPC çağrısıyla gelir. Proje veya çalışma kökü değişmişse eski pencerenin isteği reddedilir. Panel kapanır veya proje değişirse bekleyen cevabın UI'ı güncellemesi engellenir. Çekirdeğin varsayılan tam snapshot'ı ve CLI `--context` çıktısı uyumluluk için geçmişi içermeye devam eder.

Bu adım sürüm geçmişinin renderer aktarımını ve listelenmesini sınırlar; journal boyutunu veya çekirdeğin replay belleğini sınırlamaz. Kabul edilmiş sürümler, görev paketlerinin anahtar/sürüm kanıtını yeniden kurabilmek için silinmez. Çözülen kararlar ve görev paketleri için sayfalama, arşivleme/retention ve diskten sorgulama sonraki işlerdir.
