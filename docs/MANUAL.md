# ToGrill BBQ Thermometer — Manual

A short guide to the Homey app for the **ToGrill AT-02**.

🇬🇧 [English](#english) · 🇸🇪 [Svenska](#svenska)

---

## English

### How it works

The app talks to your AT-02 directly over **Bluetooth LE** — no bridge, no cloud, no phone
app. Homey polls the device for fresh readings and evaluates everything locally. A probe's
controls appear only while that probe is plugged in; the grill block appears only if your
device has the ambient (clip) sensor.

### Readings

| Reading | Shows |
|---|---|
| **Temperature – Probe 1…4** | Live probe temperature (only while connected). |
| **Grill temperature** | The ambient (clip) sensor, if fitted. |
| **Battery** | AT-02 battery level, in %. |

### Per-probe controls

| Control | Sets | Alarm fires when |
|---|---|---|
| **Target** | One "done" temperature. | the probe **reaches** it (`temp ≥ Target`). |
| **Max** | Upper limit. | the probe goes **over** Max (`temp > Max`). |
| **Min** | Lower limit. | the probe drops **below** Min (`temp < Min`). |
| **Timer** | Countdown on the device. | the timer reaches zero. |
| **Grill type** | Meat preset (beef, pork, fish, smoke…). | — |
| **Taste** | Doneness (rare → well done). | — |
| **Probe N Alarm** | — | lit while over Target/Max; clears when the temp drops back. |

**Target vs Min/Max:** Target is a single point ("tell me when it's done"); Min/Max is a
window ("tell me if it goes outside"). For a simple "alarm when done", set only **Target**
and leave Min/Max at **0** (0 = disabled). The probe range is **0–120 °C**.

### Grill (ambient) controls

If your device has the clip sensor you also get **Grill Min** (warn when too cold, e.g. the
fire is dying), **Grill Max** (warn when too hot), and the **High / Low Grill Temp** alarms
they drive. 0 = off. The grill range is **0–280 °C**.

### Other alarms

- **Probe Disconnected** — a reporting probe suddenly stopped (pulled out mid-cook).
  Auto-resets after 5 minutes.

### Device settings (gear icon)

| Setting | What it does |
|---|---|
| **Auto-silence buzzer** | Silences the thermometer's buzzer automatically when an alarm sounds. It may beep briefly first, and only works while Homey is connected. Homey Flows and notifications are unaffected. |
| **Alarm interval** | How often (minutes) the device repeats an alarm. |
| **Firmware version / Probe count** | Read-only info reported by the device. |

### Flow cards

- **Triggers:** Probe reached target · Probe disconnected · Grill too hot · Grill too cold ·
  Battery low · Probe timer elapsed.
- **Conditions:** Probe temperature is above a value.
- **Actions:** Set target temperature · Set probe timer · Set probe min/max range ·
  Set grill type · Set taste.

Probe pickers in Flows list only the probes connected right now.

---

## Svenska

### Så fungerar appen

Appen pratar med din AT-02 direkt via **Bluetooth LE** — ingen bro, inget moln, ingen
mobilapp. Homey hämtar nya värden från enheten och utvärderar allt lokalt. En sonds reglage
visas bara när sonden är inkopplad; grillblocket visas bara om din enhet har
omgivningssensorn (clip).

### Avläsningar

| Avläsning | Vad den visar |
|---|---|
| **Temperatur – Sond 1…4** | Sondens livetemperatur (bara när den är inkopplad). |
| **Grilltemperatur** | Omgivningssensorn (clip), om din enhet har en. |
| **Batteri** | Batterinivå på AT-02, i %. |

### Reglage per sond

| Reglage | Ställer in | Larmet utlöses när |
|---|---|---|
| **Mål** | *En* måltemperatur ("klart vid"). | sonden **når** målet (`temp ≥ Mål`). |
| **Max** | En övre gräns. | sonden går **över** Max (`temp > Max`). |
| **Min** | En undre gräns. | sonden faller **under** Min (`temp < Min`). |
| **Timer** | Nedräkning på enheten. | timern når noll. |
| **Grilltyp** | Förinställning för köttet (nöt, fläsk, fisk, rök…). | — |
| **Stekgrad** | Stekgrad (blodig → genomstekt). | — |
| **Sond N-larm** | — | tänds när sonden är över Mål/Max; släcks när temperaturen faller tillbaka. |

**Mål vs Min/Max:** Mål är en punkt ("säg till när det är klart"); Min/Max är ett fönster
("säg till om det åker utanför"). Vill du bara ha "larma när klart", sätt enbart **Mål** och
lämna Min/Max på **0** (0 = avstängt). Sondintervallet är **0–120 °C**.

### Grill-/omgivningsreglage

Har din enhet clip-sensorn får du även **Grill min** (varna när det blir för kallt, t.ex.
elden håller på att dö), **Grill max** (varna när det blir för varmt) och larmen **Hög / Låg
grilltemperatur** som de styr. 0 = av. Grillintervallet är **0–280 °C**.

### Övriga larm

- **Sond urkopplad** — en sond som rapporterade slutade plötsligt (urdragen mitt i
  tillagningen). Återställs automatiskt efter 5 minuter.

### Enhetsinställningar (kugghjulet)

| Inställning | Vad det gör |
|---|---|
| **Auto-tysta summer** | Tystar automatiskt termometerns summer när ett larm ljuder. Den kan pipa till kort först, och det fungerar bara medan Homey är ansluten. Homey-flöden och notiser påverkas inte. |
| **Larmintervall** | Hur ofta (minuter) enheten upprepar ett larm. |
| **Firmwareversion / Antal sonder** | Skrivskyddad info som enheten rapporterar. |

### Flow-kort

- **Utlösare:** Sond nådde måltemperatur · Sond urkopplad · Grillen för varm · Grillen för
  kall · Lågt batteri · Sondtimer löpte ut.
- **Villkor:** Sondtemperatur är över ett värde.
- **Åtgärder:** Sätt måltemperatur · Sätt sondtimer · Sätt sondens min/max · Sätt grilltyp ·
  Sätt stekgrad.

Sondväljare i Flows visar bara sonder som är anslutna just nu.

---

*This app is an independent, unofficial integration and is not affiliated with ToGrill. See
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) for attribution.*
