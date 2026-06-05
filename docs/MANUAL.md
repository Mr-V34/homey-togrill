# ToGrill BBQ Thermometer — Manual

A complete guide to every control and setting in the Homey app for the **ToGrill AT-02**.

🇬🇧 [English](#english) · 🇸🇪 [Svenska](#svenska)

---

## English

### How it works

The app connects to your ToGrill AT-02 directly over **Bluetooth LE** — no bridge, no
cloud, no separate phone app. Homey continuously asks the device for fresh readings and
shows them on the device tile. Everything is evaluated locally on your Homey.

Probe controls only appear for probes that are **actually plugged in**. Plug a probe in
and its block (Target, Min/Max, Timer, etc.) shows up; unplug it and the block hides
again, so you never scroll past unused probes. The grill (ambient) block only appears on
devices that have that sensor.

### Readings (shown automatically)

| Reading | What it shows |
|---|---|
| **Temperature – Probe 1…4** | Live meat-probe temperature. Only shown while the probe is connected. |
| **Grill temperature** | The grill's ambient (clip) sensor, if your device has one. |
| **Battery** | Battery level of the AT-02, in %. |
| **Signal strength** | Bluetooth signal in dBm (closer to 0 = stronger). Refreshes every minute. |

### Per-probe controls

Each connected probe has its own set of controls. The three temperature settings are the
ones people mix up most, so here is the exact difference:

| Control | What it does | The alarm fires when… |
|---|---|---|
| **Target (Mål)** | A single "done" temperature. **Use this if you just want to be told when the food is ready.** | the probe **reaches** the target (`temp ≥ Target`). |
| **Max** | An upper limit. | the probe goes **over** Max (`temp > Max`). |
| **Min** | A lower limit. | the probe drops **below** Min (`temp < Min`). |

**Target vs Min/Max — not the same thing:**

- **Target** is one point — "tell me when I've *arrived* at this temperature." This is the
  classic meat-thermometer use: e.g. set Target = 65 °C and get an alarm when the roast is done.
- **Min/Max** is a *window* — "tell me if I go *outside* this range." Use it to keep something
  within bounds, or as an over-/under-temperature safety warning.

> **Want a simple "alarm when done"?** Set only **Target**. Leave **Max** and **Min** at **0**
> (= disabled) so they don't add extra alarms. A threshold of 0 means "no limit".

Other per-probe controls:

| Control | What it does |
|---|---|
| **Timer** | A countdown timer for the probe, set on the device. |
| **Grill type** | The food/meat preset (beef, pork, chicken, fish, smoke, …), same as the device's own menu. |
| **Taste** | Doneness preset (rare → well done). |
| **Probe N Alarm** | Lights up when this probe reaches its Target or goes over its Max. Clears automatically when the temperature drops back. |

### Grill (ambient) controls

If your device has the grill clip sensor, you also get:

| Control | What it does |
|---|---|
| **Grill Min** | Warn when the grill runs **too cold** (e.g. the fire is dying). 0 = off. |
| **Grill Max** | Warn when the grill runs **too hot**. 0 = off. |
| **High Grill Temp / Low Grill Temp** | The alarms driven by Grill Max / Grill Min. |

Ideal for long low-and-slow sessions: set a Min so you get warned before the fire goes out.

### Other alarms

| Alarm | Meaning |
|---|---|
| **Probe Disconnected** | A probe that was reporting suddenly stopped (pulled out mid-cook). Auto-resets after 5 minutes. |

### Device settings (gear icon)

| Setting | What it does |
|---|---|
| **Alarm interval** | How often (minutes) the device repeats an alarm. |
| **Firmware version / Probe count** | Read-only info reported by the device. |

### Flow cards

- **Triggers:** Probe reached target temperature · Probe disconnected · Grill too hot ·
  Grill too cold · Battery low.
- **Conditions:** Probe temperature is above a value.
- **Actions:** Set target temperature · Set probe timer · Set probe min/max range ·
  Set grill type · Set taste.

Probe pickers in Flows only list probes that are currently connected.

---

## Svenska

### Så fungerar appen

Appen ansluter till din ToGrill AT-02 direkt via **Bluetooth LE** — ingen bro, inget moln,
ingen separat mobilapp. Homey frågar löpande enheten efter nya värden och visar dem på
enhetsrutan. Allt utvärderas lokalt på din Homey.

Sondernas reglage visas bara för sonder som **faktiskt är inkopplade**. Koppla in en sond så
dyker dess block upp (Mål, Min/Max, Timer m.m.); koppla ur den och blocket göms igen, så du
slipper scrolla förbi oanvända sonder. Grill-/omgivningsblocket visas bara på enheter som har
den sensorn.

### Avläsningar (visas automatiskt)

| Avläsning | Vad den visar |
|---|---|
| **Temperatur – Sond 1…4** | Sondens livetemperatur. Visas bara när sonden är inkopplad. |
| **Grilltemperatur** | Grillens omgivningssensor (clip), om din enhet har en. |
| **Batteri** | Batterinivå på AT-02, i %. |
| **Signalstyrka** | Bluetooth-signal i dBm (närmare 0 = starkare). Uppdateras varje minut. |

### Reglage per sond

Varje inkopplad sond har sin egen uppsättning reglage. De tre temperaturinställningarna är de
som oftast blandas ihop, så här är den exakta skillnaden:

| Reglage | Vad det gör | Larmet utlöses när… |
|---|---|---|
| **Mål** | *En* måltemperatur ("klart vid"). **Använd detta om du bara vill bli meddelad när maten är klar.** | sonden **når** målet (`temp ≥ Mål`). |
| **Max** | En övre gräns. | sonden går **över** Max (`temp > Max`). |
| **Min** | En undre gräns. | sonden faller **under** Min (`temp < Min`). |

**Mål vs Min/Max — inte samma sak:**

- **Mål** är en punkt — "säg till när jag *kommit upp* till den här temperaturen." Det klassiska
  köttermometer-bruket: t.ex. Mål = 65 °C och få larm när steken är klar.
- **Min/Max** är ett *fönster* — "säg till om jag åker *utanför* det här intervallet." Använd det
  för att hålla något inom gränser, eller som en varning för över-/undertemperatur.

> **Vill du bara ha "larma när klart"?** Sätt bara **Mål**. Lämna **Max** och **Min** på **0**
> (= avstängt) så de inte lägger till extra larm. Tröskelvärdet 0 betyder "ingen gräns".

Övriga reglage per sond:

| Reglage | Vad det gör |
|---|---|
| **Timer** | En nedräkningstimer för sonden, satt på enheten. |
| **Grilltyp** | Förinställning för maten/köttet (nöt, fläsk, kyckling, fisk, rök, …), samma som enhetens egen meny. |
| **Stekgrad** | Förinställning för stekgrad (blodig → genomstekt). |
| **Sond N-larm** | Tänds när sonden når sitt Mål eller går över sitt Max. Släcks automatiskt när temperaturen faller tillbaka. |

### Grill-/omgivningsreglage

Har din enhet grillens clip-sensor får du även:

| Reglage | Vad det gör |
|---|---|
| **Grill min** | Varna när grillen blir **för kall** (t.ex. elden håller på att dö). 0 = av. |
| **Grill max** | Varna när grillen blir **för varm**. 0 = av. |
| **Hög grilltemperatur / Låg grilltemperatur** | Larmen som styrs av Grill max / Grill min. |

Perfekt för långa lågtempspass: sätt en Min så du varnas innan elden slocknar.

### Övriga larm

| Larm | Betydelse |
|---|---|
| **Sond urkopplad** | En sond som rapporterade slutade plötsligt (urdragen mitt i tillagningen). Återställs automatiskt efter 5 minuter. |

### Enhetsinställningar (kugghjulet)

| Inställning | Vad det gör |
|---|---|
| **Larmintervall** | Hur ofta (minuter) enheten upprepar ett larm. |
| **Firmwareversion / Antal sonder** | Skrivskyddad info som enheten rapporterar. |

### Flow-kort

- **Utlösare:** Sond nådde måltemperatur · Sond urkopplad · Grillen för varm ·
  Grillen för kall · Lågt batteri.
- **Villkor:** Sondtemperatur är över ett värde.
- **Åtgärder:** Sätt måltemperatur · Sätt sondtimer · Sätt sondens min/max · Sätt grilltyp ·
  Sätt stekgrad.

Sondväljare i Flows visar bara sonder som är anslutna just nu.

---

*This app is an independent, unofficial integration and is not affiliated with ToGrill. See
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) for attribution.*
