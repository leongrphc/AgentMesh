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

Açık kapsam: görevle ilgili anahtarları seçen sınırlı context paketleri, tüketilen sürümlerin görev bazında kaydı ve büyük geçmişler için sayfalama/retention. Mevcut istem yalnızca kabul edilmiş güncel değerleri ve sürümlerini içerir; geçmiş veya bekleyen öneri otomatik isteme eklenmez.
