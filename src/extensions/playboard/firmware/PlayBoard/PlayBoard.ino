/*
 * PlayBoard + PlayShield V2 — firmware de referencia
 * MCU: ATmega328p (Arduino UNO)
 *
 * Protocolo completo: ../../PROTOCOLO.md
 *
 * Bibliotecas necesarias (Arduino IDE → Gestor de bibliotecas):
 *   - ArduinoJson (v6.x)          by Benoit Blanchon
 *   - Adafruit SSD1306            by Adafruit
 *   - Adafruit GFX Library       by Adafruit
 *
 * Flasheo: Arduino IDE, placa "Arduino Uno", puerto COM correspondiente.
 * PlayCode NO actualiza este firmware (el ATmega328p no usa esptool).
 *
 * Nota SRAM (2 KB en el UNO): el framebuffer del SSD1306 128x64 usa ~1 KB.
 * Por eso la telemetría se arma con Serial.print directo (sin un segundo
 * JsonDocument) y el parser de entrada usa un StaticJsonDocument pequeño.
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>

// ── OLED ─────────────────────────────────────────────────────────────────────
#define OLED_W 128
#define OLED_H 64            // si tu pantalla es 128x32, cambia a 32
#define OLED_ADDR 0x3C
Adafruit_SSD1306 display(OLED_W, OLED_H, &Wire, -1);
bool oledOk = false;

// ── Pines ────────────────────────────────────────────────────────────────────
// Motores (H-puente doble PWM). Los 4 son pines PWM del UNO.
const uint8_t M1_A = 3,  M1_B = 11;   // Motor M1
const uint8_t M2_A = 5,  M2_B = 6;    // Motor M2

// Entrada/Salida digital de propósito general.
const uint8_t DIO[] = {2, 4, 7, 8, 9, 10};
const uint8_t N_DIO = sizeof(DIO) / sizeof(DIO[0]);
bool dioIsOutput[N_DIO] = {false, false, false, false, false, false};
uint8_t dioOutVal[N_DIO] = {0, 0, 0, 0, 0, 0};

// Botones.
const uint8_t BTN1 = 12, BTN2 = 13;

// Entradas analógicas.
const uint8_t POT = A0;
const uint8_t A_IN[] = {A1, A2, A3};

// ── Estado ───────────────────────────────────────────────────────────────────
char lineBuf[140];
uint8_t lineLen = 0;
unsigned long lastTelemetry = 0;
const unsigned long TELEMETRY_MS = 100;

// ─────────────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);

    // Motores: pines de salida, parados.
    pinMode(M1_A, OUTPUT); pinMode(M1_B, OUTPUT);
    pinMode(M2_A, OUTPUT); pinMode(M2_B, OUTPUT);
    stopMotors();

    // I/O digital: por defecto entrada con pull-up.
    for (uint8_t i = 0; i < N_DIO; i++) pinMode(DIO[i], INPUT_PULLUP);

    // Botones con pull-up (presionado = LOW; se invierte al reportar).
    pinMode(BTN1, INPUT_PULLUP);
    pinMode(BTN2, INPUT_PULLUP);

    // OLED.
    Wire.begin();
    oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
    if (oledOk) {
        display.clearDisplay();
        display.setTextColor(SSD1306_WHITE);
        display.setTextSize(1);
        display.setCursor(0, 0);
        display.println(F("PlayBoard"));
        display.display();
    }
}

void loop() {
    readSerial();

    unsigned long now = millis();
    if (now - lastTelemetry >= TELEMETRY_MS) {
        lastTelemetry = now;
        sendTelemetry();
    }
}

// ── Serial: acumular por líneas y despachar ─────────────────────────────────
void readSerial() {
    while (Serial.available() > 0) {
        char c = (char) Serial.read();
        if (c == '\n' || c == '\r') {
            if (lineLen > 0) {
                lineBuf[lineLen] = '\0';
                handleLine(lineBuf);
                lineLen = 0;
            }
        } else if (lineLen < sizeof(lineBuf) - 1) {
            lineBuf[lineLen++] = c;
        } else {
            lineLen = 0; // línea demasiado larga: descartar
        }
    }
}

void handleLine(const char* line) {
    StaticJsonDocument<192> doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) return;

    // Envelope: {"command":"outputsQueue","testValue":[ {...}, ... ]}
    JsonArray arr = doc["testValue"].as<JsonArray>();
    if (arr.isNull()) return;

    for (JsonObject cmd : arr) {
        execCommand(cmd);
    }
}

void execCommand(JsonObject cmd) {
    const char* c = cmd["command"];
    if (!c) return;

    if (!strcmp(c, "setMotors")) {
        setMotor(1, cmd["m1"] | 0);
        setMotor(2, cmd["m2"] | 0);
    } else if (!strcmp(c, "setMotor")) {
        setMotor(cmd["motor"] | 0, cmd["speed"] | 0);
    } else if (!strcmp(c, "stopMotors")) {
        stopMotors();
    } else if (!strcmp(c, "digitalWrite")) {
        doDigitalWrite(cmd["pin"] | -1, (cmd["value"] | 0) ? 1 : 0);
    } else if (!strcmp(c, "oledClear")) {
        if (oledOk) display.clearDisplay();
        oledFlush();
    } else if (!strcmp(c, "oledText")) {
        if (oledOk) {
            display.clearDisplay();
            display.setTextSize(cmd["size"] | 1);
            display.setCursor(0, 0);
            display.print((const char*)(cmd["text"] | ""));
        }
        oledFlush();
    } else if (!strcmp(c, "oledNumber")) {
        oledNumber(cmd["line"] | 0, cmd["label"] | "", cmd["value"] | 0);
    } else if (!strcmp(c, "oledLine")) {
        oledLineText(cmd["line"] | 0, cmd["text"] | "");
    } else if (!strcmp(c, "oledTextXY")) {
        if (oledOk) {
            display.setTextSize(cmd["size"] | 1);
            display.setCursor(cmd["x"] | 0, cmd["y"] | 0);
            display.print((const char*)(cmd["text"] | ""));
        }
        oledFlush();
    } else if (!strcmp(c, "oledDrawLine")) {
        if (oledOk) display.drawLine(cmd["x0"] | 0, cmd["y0"] | 0, cmd["x1"] | 0, cmd["y1"] | 0, SSD1306_WHITE);
        oledFlush();
    } else if (!strcmp(c, "oledDrawRect")) {
        if (oledOk) display.drawRect(cmd["x"] | 0, cmd["y"] | 0, cmd["w"] | 0, cmd["h"] | 0, SSD1306_WHITE);
        oledFlush();
    } else if (!strcmp(c, "oledFillRect")) {
        if (oledOk) display.fillRect(cmd["x"] | 0, cmd["y"] | 0, cmd["w"] | 0, cmd["h"] | 0, SSD1306_WHITE);
        oledFlush();
    } else if (!strcmp(c, "oledDrawCircle")) {
        if (oledOk) display.drawCircle(cmd["x"] | 0, cmd["y"] | 0, cmd["r"] | 0, SSD1306_WHITE);
        oledFlush();
    } else if (!strcmp(c, "oledDrawPixel")) {
        if (oledOk) display.drawPixel(cmd["x"] | 0, cmd["y"] | 0, SSD1306_WHITE);
        oledFlush();
    } else if (!strcmp(c, "oledDisplay")) {
        oledFlush();
    }
}

// ── Motores ──────────────────────────────────────────────────────────────────
void setMotor(int motor, int speed) {
    if (speed > 100) speed = 100;
    if (speed < -100) speed = -100;
    uint8_t pinA = (motor == 1) ? M1_A : M2_A;
    uint8_t pinB = (motor == 1) ? M1_B : M2_B;
    if (motor != 1 && motor != 2) return;

    int pwm = map(abs(speed), 0, 100, 0, 255);
    if (speed > 0)      { analogWrite(pinA, pwm); analogWrite(pinB, 0); }
    else if (speed < 0) { analogWrite(pinA, 0);   analogWrite(pinB, pwm); }
    else                { analogWrite(pinA, 0);   analogWrite(pinB, 0); }
}

void stopMotors() {
    analogWrite(M1_A, 0); analogWrite(M1_B, 0);
    analogWrite(M2_A, 0); analogWrite(M2_B, 0);
}

// ── I/O digital ──────────────────────────────────────────────────────────────
void doDigitalWrite(int pin, int value) {
    for (uint8_t i = 0; i < N_DIO; i++) {
        if (DIO[i] == pin) {
            if (!dioIsOutput[i]) { pinMode(pin, OUTPUT); dioIsOutput[i] = true; }
            dioOutVal[i] = value;
            digitalWrite(pin, value ? HIGH : LOW);
            return;
        }
    }
}

// ── OLED helpers ─────────────────────────────────────────────────────────────
void oledFlush() {
    if (oledOk) display.display();
}

// Cada "línea" son 8 px de alto en tamaño 1 (16 en tamaño 2). Aquí líneas de 16 px.
void oledLineText(int line, const char* text) {
    if (!oledOk) return;
    int y = line * 16;
    display.fillRect(0, y, OLED_W, 16, SSD1306_BLACK); // limpiar solo esa franja
    display.setTextSize(2);
    display.setCursor(0, y);
    display.print(text);
    oledFlush();
}

void oledNumber(int line, const char* label, long value) {
    if (!oledOk) return;
    int y = line * 16;
    display.fillRect(0, y, OLED_W, 16, SSD1306_BLACK);
    display.setTextSize(2);
    display.setCursor(0, y);
    display.print(label);
    display.print(F(": "));
    display.print(value);
    oledFlush();
}

// ── Telemetría ───────────────────────────────────────────────────────────────
void sendTelemetry() {
    // Armada a mano para no gastar SRAM en un segundo JsonDocument.
    Serial.print(F("{\"inputs\":{\"pot\":"));
    Serial.print(analogRead(POT));
    Serial.print(F(",\"a1\":")); Serial.print(analogRead(A_IN[0]));
    Serial.print(F(",\"a2\":")); Serial.print(analogRead(A_IN[1]));
    Serial.print(F(",\"a3\":")); Serial.print(analogRead(A_IN[2]));

    for (uint8_t i = 0; i < N_DIO; i++) {
        Serial.print(F(",\"d")); Serial.print(DIO[i]); Serial.print(F("\":"));
        if (dioIsOutput[i]) {
            Serial.print(dioOutVal[i]);            // pin en salida: reportar valor escrito
        } else {
            Serial.print(digitalRead(DIO[i]));     // pin en entrada: lectura cruda
        }
    }

    // Botones con pull-up: presionado = LOW → invertir para reportar 1 = presionado.
    Serial.print(F(",\"btn1\":")); Serial.print(digitalRead(BTN1) == LOW ? 1 : 0);
    Serial.print(F(",\"btn2\":")); Serial.print(digitalRead(BTN2) == LOW ? 1 : 0);

    Serial.print(F("},\"version\":\"1.0\"}\n"));
}
