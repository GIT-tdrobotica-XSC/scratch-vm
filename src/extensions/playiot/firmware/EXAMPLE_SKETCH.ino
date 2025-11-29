/**
 * PlayIoT ESP32 - Sketch de Ejemplo
 * Este es un ejemplo de cómo implementar el protocolo de comunicación
 * con auto-detección de firmware
 *
 * Dependencias requeridas:
 * - ArduinoJson (versión 6.x)
 * - Adafruit_NeoPixel (para LEDs RGB)
 */

#include <ArduinoJson.h>
#include <Adafruit_NeoPixel.h>

// Versión del firmware (para auto-detección)
#define FIRMWARE_VERSION "1.0.0"
#define DEVICE_NAME "PlayIoT-ESP32"

// Configuración de pines
#define PIN_LED_2    2
#define PIN_LED_5    5
#define PIN_LED_23   23

#define PIN_MOTOR_12 12
#define PIN_MOTOR_13 13
#define PIN_MOTOR_18 18
#define PIN_MOTOR_19 19

#define PIN_SERVO_25 25
#define PIN_SERVO_26 26
#define PIN_SERVO_27 27

#define PIN_RGB_LED  15
#define NUM_LEDS     3

#define PIN_BUTTON_A 32
#define PIN_BUTTON_B 33

#define PIN_POT      34
#define PIN_JOY_X    35
#define PIN_JOY_Y    36
#define PIN_ADC_33   39
#define PIN_ADC_34   34
#define PIN_ADC_35   35

// NeoPixel
Adafruit_NeoPixel strip = Adafruit_NeoPixel(NUM_LEDS, PIN_RGB_LED, NEO_GRB + NEO_KHZ800);

// Variables globales
String inputBuffer = "";
unsigned long lastSensorRead = 0;
const int SENSOR_READ_INTERVAL = 50; // ms

void setup() {
  Serial.begin(115200);

  // Configurar pines digitales
  pinMode(PIN_LED_2, OUTPUT);
  pinMode(PIN_LED_5, OUTPUT);
  pinMode(PIN_LED_23, OUTPUT);

  pinMode(PIN_MOTOR_12, OUTPUT);
  pinMode(PIN_MOTOR_13, OUTPUT);
  pinMode(PIN_MOTOR_18, OUTPUT);
  pinMode(PIN_MOTOR_19, OUTPUT);

  // Configurar botones
  pinMode(PIN_BUTTON_A, INPUT_PULLUP);
  pinMode(PIN_BUTTON_B, INPUT_PULLUP);

  // Inicializar NeoPixel
  strip.begin();
  strip.show();

  Serial.println("PlayIoT ESP32 iniciado");
  Serial.println("Firmware v" + String(FIRMWARE_VERSION));
}

void loop() {
  // Procesar comandos seriales
  processSerialCommands();

  // Enviar datos de sensores periódicamente
  if (millis() - lastSensorRead >= SENSOR_READ_INTERVAL) {
    sendSensorData();
    lastSensorRead = millis();
  }
}

/**
 * Procesa comandos JSON recibidos por Serial
 */
void processSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n') {
      // Línea completa recibida, procesar
      if (inputBuffer.length() > 0) {
        handleCommand(inputBuffer);
        inputBuffer = "";
      }
    } else {
      inputBuffer += c;

      // Protección contra buffer overflow
      if (inputBuffer.length() > 1024) {
        inputBuffer = "";
      }
    }
  }
}

/**
 * Maneja un comando JSON
 */
void handleCommand(String jsonString) {
  DynamicJsonDocument doc(1024);
  DeserializationError error = deserializeJson(doc, jsonString);

  if (error) {
    Serial.println("{\"error\":\"JSON inválido\"}");
    return;
  }

  String command = doc["command"];

  // 🔍 COMANDO DE VERSION (para auto-detección)
  if (command == "getVersion") {
    sendVersionInfo();
    return;
  }

  // COMANDO DE OUTPUTS
  if (command == "outputsQueue") {
    JsonArray testValue = doc["testValue"];

    for (JsonObject cmd : testValue) {
      String cmdType = cmd["command"];

      if (cmdType == "digitalWrite") {
        int pin = cmd["pin"];
        int value = cmd["value"];
        digitalWrite(pin, value);
      }
      else if (cmdType == "analogWrite") {
        int pin = cmd["pin"];
        int value = cmd["value"];
        ledcWrite(pin, value);
      }
      else if (cmdType == "setPixelColor") {
        int pixel = cmd["pixel"];
        int r = cmd["r"];
        int g = cmd["g"];
        int b = cmd["b"];
        strip.setPixelColor(pixel, strip.Color(r, g, b));
        strip.show();
      }
      else if (cmdType == "servo") {
        int channel = cmd["channel"];
        int angle = cmd["angle"];
        int dutyCycle = map(angle, 0, 180, 26, 128);
        ledcWrite(channel, dutyCycle);
      }
    }
  }
}

/**
 * 🔥 Envía información de versión (CRÍTICO para auto-detección)
 */
void sendVersionInfo() {
  DynamicJsonDocument doc(128);
  doc["version"] = FIRMWARE_VERSION;
  doc["device"] = DEVICE_NAME;

  String output;
  serializeJson(doc, output);
  Serial.println(output);
}

/**
 * Envía datos de sensores al servidor
 */
void sendSensorData() {
  DynamicJsonDocument doc(512);
  JsonObject inputs = doc.createNestedObject("inputs");

  // Leer botones (invertido por pull-up)
  inputs["button_A"] = !digitalRead(PIN_BUTTON_A);
  inputs["button_B"] = !digitalRead(PIN_BUTTON_B);

  // Leer analógicos
  inputs["analog_POT"] = analogRead(PIN_POT);
  inputs["analog_X"] = analogRead(PIN_JOY_X);
  inputs["analog_Y"] = analogRead(PIN_JOY_Y);
  inputs["analog_ADC33"] = analogRead(PIN_ADC_33);
  inputs["analog_ADC34"] = analogRead(PIN_ADC_34);
  inputs["analog_ADC35"] = analogRead(PIN_ADC_35);

  // Límites del joystick
  int joyX = analogRead(PIN_JOY_X);
  int joyY = analogRead(PIN_JOY_Y);

  inputs["upLimit"] = (joyY > 3000) ? 1 : 0;
  inputs["downLimit"] = (joyY < 1000) ? 1 : 0;
  inputs["rightLimit"] = (joyX > 3000) ? 1 : 0;
  inputs["leftLimit"] = (joyX < 1000) ? 1 : 0;

  String output;
  serializeJson(doc, output);
  Serial.println(output);
}
