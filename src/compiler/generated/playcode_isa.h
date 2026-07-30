/* =====================================================================
 *  ARCHIVO GENERADO -- NO EDITAR A MANO
 *
 *  Fuente:    scratch-vm/src/compiler/isa.js
 *  Regenerar: npm run isa:gen      (dentro de scratch-vm)
 *  Verificar: npm run isa:check    (corre solo en npm test)
 *
 *  sha256 de la fuente: 290d5c021796ec59dd77dec722ee92b2328ae48dd381eab62315373ef2d1ee54
 *
 *  Si editas este archivo a mano, el siguiente `npm test` fallara.
 *  Cambia isa.js y regenera.
 * ===================================================================== */

#ifndef PLAYCODE_ISA_H
#define PLAYCODE_ISA_H

#include <stdint.h>

/* Version del juego de instrucciones. La placa la reporta en su
 * telemetria ("isa":N) y la valida al recibir un programa. */
#define PC_ISA_VERSION 1

/* Identificadores de placa (van en la cabecera del programa). */
#define PC_BOARD_PLAYGO 1
#define PC_BOARD_PLAYIOT 2
#define PC_BOARD_PLAYME 3
#define PC_BOARD_PLAYBOARD 4

/* Layout de la cabecera (16 bytes, little-endian). */
#define PC_MAGIC 0x43424350  /* 'PCBC' */
#define PC_HEADER_SIZE 16
#define PC_THREAD_ENTRY_SIZE 3
#define PC_OFF_MAGIC 0
#define PC_OFF_ISA_VERSION 4
#define PC_OFF_BOARD_ID 5
#define PC_OFF_FLAGS 6
#define PC_OFF_NUM_VARS 8
#define PC_OFF_NUM_THREADS 10
#define PC_OFF_NUM_STRINGS 11
#define PC_OFF_CODE_SIZE 12
#define PC_OFF_HEADER_CRC 14

/* Banderas de la cabecera. */
#define PC_FLAG_AUTORUN 0x0001

/* Opcodes. */
enum PcOp {
    PC_OP_NOP = 0x00,
    PC_OP_PUSH_F32 = 0x01,
    PC_OP_PUSH_I8 = 0x02,
    PC_OP_PUSH_STR = 0x03,
    PC_OP_PUSH_TRUE = 0x04,
    PC_OP_PUSH_FALSE = 0x05,
    PC_OP_POP = 0x06,
    PC_OP_DUP = 0x07,
    PC_OP_LOAD_VAR = 0x10,
    PC_OP_STORE_VAR = 0x11,
    PC_OP_CHANGE_VAR = 0x12,
    PC_OP_ADD = 0x20,
    PC_OP_SUB = 0x21,
    PC_OP_MUL = 0x22,
    PC_OP_DIV = 0x23,
    PC_OP_MOD = 0x24,
    PC_OP_RANDOM = 0x25,
    PC_OP_ROUND = 0x26,
    PC_OP_MATHOP = 0x27,
    PC_OP_LT = 0x30,
    PC_OP_EQ = 0x31,
    PC_OP_GT = 0x32,
    PC_OP_AND = 0x33,
    PC_OP_OR = 0x34,
    PC_OP_NOT = 0x35,
    PC_OP_JOIN = 0x40,
    PC_OP_LETTER_OF = 0x41,
    PC_OP_LENGTH = 0x42,
    PC_OP_CONTAINS = 0x43,
    PC_OP_JMP = 0x50,
    PC_OP_JZ = 0x51,
    PC_OP_JNZ = 0x52,
    PC_OP_REPEAT_SETUP = 0x53,
    PC_OP_LOOP_TEST = 0x54,
    PC_OP_LOOP_NEXT = 0x55,
    PC_OP_YIELD = 0x60,
    PC_OP_WAIT = 0x61,
    PC_OP_STOP = 0x63,
    PC_OP_HALT = 0x64,
    PC_OP_TIMER = 0x66,
    PC_OP_TIMER_RESET = 0x67,
    PC_OP_CALL_HW = 0x70,
    PC_OP_CALL_HW_R = 0x71,
    PC_OP_CALL_HW_WAIT = 0x72,
    PC_OP_TRAP = 0x7F
};

/* Funciones de operator_mathop, en el orden que numera el bytecode. */
enum PcMathOp {
    PC_MATHOP_ABS = 0,
    PC_MATHOP_FLOOR = 1,
    PC_MATHOP_CEILING = 2,
    PC_MATHOP_SQRT = 3,
    PC_MATHOP_SIN = 4,
    PC_MATHOP_COS = 5,
    PC_MATHOP_TAN = 6,
    PC_MATHOP_ASIN = 7,
    PC_MATHOP_ACOS = 8,
    PC_MATHOP_ATAN = 9,
    PC_MATHOP_LN = 10,
    PC_MATHOP_LOG = 11,
    PC_MATHOP_E_ = 12,
    PC_MATHOP_10_ = 13
};

/* Modos de control_stop. */
#define PC_STOP_ALL 0
#define PC_STOP_THIS_SCRIPT 1
#define PC_STOP_OTHER_SCRIPTS_IN_SPRITE 2

/* Tipos de sombrero (bloque de inicio) de cada hilo. */
#define PC_HAT_WHEN_FLAG_CLICKED 0

/* Codigos de error de ejecucion, reportados en {"prog":{"err":N}}. */
enum PcError {
    PC_ERR_NONE = 0,
    PC_ERR_STACK_OVERFLOW = 1,
    PC_ERR_BAD_OPCODE = 2,
    PC_ERR_BAD_HW_ID = 3,
    PC_ERR_ARITY = 4,
    PC_ERR_DOMAIN = 5,
    PC_ERR_CRC = 6,
    PC_ERR_RUNAWAY = 7
};

/* ---- Primitivas de hardware: playgo ---- */
enum PcHwPlaygo {
    PC_HW_PLAYGO_SET_MOTOR_SPEED = 0x01,
    PC_HW_PLAYGO_STOP_MOTORS = 0x02,
    PC_HW_PLAYGO_MOVE_DISTANCE = 0x03,
    PC_HW_PLAYGO_TURN_ANGLE = 0x04,
    PC_HW_PLAYGO_TURN_WHEEL_REVS = 0x05,
    PC_HW_PLAYGO_RESET_ENCODERS = 0x06,
    PC_HW_PLAYGO_SERVO_WRITE = 0x10,
    PC_HW_PLAYGO_DIGITAL_WRITE = 0x11,
    PC_HW_PLAYGO_SET_IOMODE = 0x12,
    PC_HW_PLAYGO_SET_RGB = 0x20,
    PC_HW_PLAYGO_OLED_TEXT = 0x30,
    PC_HW_PLAYGO_OLED_NUMBER = 0x31,
    PC_HW_PLAYGO_OLED_CLEAR = 0x32,
    PC_HW_PLAYGO_OLED_LINE = 0x33,
    PC_HW_PLAYGO_OLED_TEXT_XY = 0x34,
    PC_HW_PLAYGO_OLED_EMOJI = 0x35,
    PC_HW_PLAYGO_OLED_DRAW_LINE = 0x36,
    PC_HW_PLAYGO_OLED_DRAW_RECT = 0x37,
    PC_HW_PLAYGO_OLED_FILL_RECT = 0x38,
    PC_HW_PLAYGO_OLED_DRAW_CIRCLE = 0x39,
    PC_HW_PLAYGO_OLED_DRAW_PIXEL = 0x3A,
    PC_HW_PLAYGO_OLED_DISPLAY = 0x3B,
    PC_HW_PLAYGO_TONE = 0x40,
    PC_HW_PLAYGO_TONE_STOP = 0x41,
    PC_HW_PLAYGO_TONE_STOP_IF = 0x42,  /* FALTA EN EL FIRMWARE */
    PC_HW_PLAYGO_READ_BUTTON = 0x50,  /* FALTA EN EL FIRMWARE */
    PC_HW_PLAYGO_READ_GPIO = 0x51,  /* FALTA EN EL FIRMWARE */
    PC_HW_PLAYGO_READ_ANALOG = 0x52,  /* FALTA EN EL FIRMWARE */
    PC_HW_PLAYGO_READ_ENCODER = 0x53,  /* FALTA EN EL FIRMWARE */
    PC_HW_PLAYGO_MIC_LEVEL = 0x54  /* FALTA EN EL FIRMWARE */
};

/* Aridad de cada primitiva, indexada por id. El interprete DEBE
 * verificar que el argc de la instruccion coincida y abortar con
 * PC_ERR_ARITY si no: es lo que convierte una desincronizacion de
 * tablas en un error limpio en vez de una pila corrupta moviendo
 * motores al azar. Un 0xFF marca un id no asignado. */
static const uint8_t PC_HW_ARGC_PLAYGO[] = {
    0xFF, 2, 0, 4, 5, 4, 0, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    2, 2, 1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    4, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    2, 3, 0, 2, 4, 3, 4, 4,
    4, 3, 2, 0, 0xFF, 0xFF, 0xFF, 0xFF,
    2, 0, 1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    1, 1, 1, 1, 0
};
#define PC_HW_COUNT_PLAYGO 30
#define PC_HW_MAX_ID_PLAYGO 0x54

#endif /* PLAYCODE_ISA_H */
