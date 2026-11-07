# Yerel deneme sürümü — 21 Ekim 2026

> **7 Kasım güncellemesi:** Gerçek proje artık config dosyası olmadan açılıyor: proje menüsü → **Klasör aç…**. Güncel adımlar [README](../README.md#5-dakikada-başla) içinde. Aşağıdaki notlar 21 Ekim kontrol noktasının kaydıdır.

Bu kontrol noktası masaüstü MVP'sini denemek içindir. Taşınabilir Windows klasörü üretilebilir; kurulum sihirbazı ve otomatik güncelleme henüz yok. Mevcut çalışma alanından açmak için:

```powershell
cd D:\WebGpt
npm run desktop
```

## İlk deneme

1. Varsayılan demo projesinde **Ajanları başlat** seçeneğini kullanın. Demo gerçek model çağırmaz.
2. İlk görevin örnek izin isteğini onaylayın; bağımlı görevlerin ve paralel ajanların ilerlemesini izleyin.
3. Görevleri seçerek sonuçları, ortak context'i ve mesajları inceleyin.
4. Editörde dosya açma, sekmeler ve taslak kurtarmayı; Terminal bölümünde komut çalıştırmayı deneyin. Terminal normal kullanıcı yetkileriyle çalışır.
5. Uygulamayı kapatıp yeniden açarak kalıcı görev durumlarını kontrol edin. Tamamlanmış demo görevleri kendiliğinden yeniden çalışmaz.

Gerçek proje ve sağlayıcı kurulumu için [README](../README.md) adımlarını izleyin. Ajan merkezindeki gerçek mesaj testi hesap/kota kullanır; demo akışından ayrıdır.

## Doğrulama

- TypeScript kontrolü başarılı; tam test süiti **129/129** geçti.
- Masaüstü derlemesi ve Electron smoke başarılı: preload/sandbox, Monaco, taslak kurtarma, disk çakışması, gerçek PTY, demo görevleri, context kararları ve gerçek Git merge çakışması çözümü.
- Codex'in tur başlatma yanıtından önce gelen sonucu kaybetmesi düzeltildi; erken bildirimlerin kapsamı ve tampon sınırı test edildi.
- SQLite inbox sayaçları teslim geçmişini Node belleğine taşımadan hesaplanıyor; arşiv ve yeni olaylarla eşdeğerliği doğrulandı.
- Bu doğrulama turunda gerçek model çağrısı yapılmadı.

## Kalan kapsam

Tam ürün planı henüz bitmedi. Gerçek sağlayıcılarla kod/araç/resume kabul testleri, OpenCode canlı inbox, genel OS sandbox, config revizyonlarını uzlaştırma ekranı ve kurulum sihirbazı/otomatik güncelleme açık. Ayrıntılı takip [TASKS.md](TASKS.md) içinde. Bu sürüm yerel deneme için doğrulanmış bir kontrol noktasıdır.

## Taşınabilir Windows paketi

`npm run desktop:package`, `dist/releases/AgentMesh-0.1.0-win-<mimari>-<benzersiz ek>` altında Electron ve native terminal bağımlılıklarını içeren ayrı bir klasör üretir. Önceki paketlerin üzerine yazmaz. Klasördeki `AgentMesh.exe` ile açın; klasörün tamamını birlikte taşıyın. Hedef bilgisayarda Node/npm gerekmez. Gerçek Git projeleri için Git, sağlayıcılar için ilgili CLI ve hesap kurulumu gerekir. Kullanıcı verileri Electron kullanıcı veri dizininde saklanır; uygulama klasörünün yanında tutulmaz.

Paket imzasız yerel deneme içindir; yayımlanmış/signed bir sürüm veya otomatik güncelleme kanalı değildir. `build-info.json`, sürüm, mimari, Electron sürümü ve yalnızca yürütülebilir dosyanın SHA-256 değerini içerir; tüm paketin bütünlüğünü doğrulamaz.

21 Ekim paket kabulü: paket kaynak depo dışındaki geçici dizine kopyalanıp kendi exe dosyasıyla çalıştırıldı. Tam Electron smoke (Monaco, gerçek PTY, context ve merge çözümü dahil) exit 0 ile geçti. Bu, mevcut Windows bilgisayarında doğrulandı; temiz bilgisayar kabulü henüz yapılmadı. Paket üretimi üçüncü taraf lisans bildirimlerini de ekler.
