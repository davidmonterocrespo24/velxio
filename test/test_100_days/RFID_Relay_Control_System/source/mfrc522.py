from machine import Pin, SPI
from os import uname

emptyRecv = b""

class MFRC522:

    GAIN_REG = 0x26
    MAX_GAIN = 0x07

    OK = 0
    NOTAGERR = 1
    ERR = 2

    REQIDL = 0x26
    REQALL = 0x52
    AUTHENT1A = 0x60
    AUTHENT1B = 0x61

    def __init__(self, spi=None, gpioRst=None, gpioCs=None):

        if gpioRst is not None:
            self.rst = Pin(gpioRst, Pin.OUT)
        else:
            self.rst = None
        assert(gpioCs is not None, "Needs gpioCs") # TODO fails without cableSelect
        if gpioCs is not None:
            self.cs = Pin(gpioCs, Pin.OUT)
        else:
            self.cs = None

        # TODO CH rationalise which of these are referenced, which can be identical
        self.regBuf = bytearray(4)
        self.blockWriteBuf = bytearray(18)
        self.authBuf = bytearray(12)
        self.wregBuf = bytearray(2)
        self.rregBuf = bytearray(1)
        self.recvBuf = bytearray(16)
        self.recvMv = memoryview(self.recvBuf)

        if self.rst is not None:
            self.rst.value(0)
        if self.cs is not None:
            self.cs.value(1)

        if spi is not None:
            self.spi = spi
        else:
            sck = Pin(14, Pin.OUT)
            mosi = Pin(13, Pin.OUT)
            miso = Pin(12, Pin.IN)
            if uname()[0] == 'WiPy':
                self.spi = SPI(0)
                self.spi.init(SPI.MASTER, baudrate=1000000, pins=(sck, mosi, miso))
            elif uname()[0] == 'esp8266': # TODO update to match https://github.com/cefn/avatap/blob/master/python/host/cockle.py #prepareHost()
                self.spi = SPI(baudrate=100000, polarity=0, phase=0, sck=sck, mosi=mosi, miso=miso)
                self.spi.init()
            else:
                raise RuntimeError("Unsupported platform")

        if self.rst is not None:
            self.rst.value(1)
        self.init()

    def _wreg(self, reg, val):
        if self.cs is not None:
            self.cs.value(0)
        buf = self.wregBuf
        buf[0]=0xff & ((reg << 1) & 0x7e)
        buf[1]=0xff & val
        self.spi.write(buf)
        if self.cs is not None:
            self.cs.value(1)

    def _rreg(self, reg):
        if self.cs is not None:
            self.cs.value(0)
        buf = self.rregBuf
        buf[0]=0xff & (((reg << 1) & 0x7e) | 0x80)
        self.spi.write(buf)
        val = self.spi.read(1)
        if self.cs is not None:
            self.cs.value(1)

        return val[0]

    def _sflags(self, reg, mask):
        self._wreg(reg, self._rreg(reg) | mask)

    def _cflags(self, reg, mask):
        self._wreg(reg, self._rreg(reg) & (~mask))

    def _tocard(self, cmd, send, into=None):

        recv = emptyRecv
        bits = irq_en = wait_irq = n = 0
        stat = self.ERR

        if cmd == 0x0E:
            irq_en = 0x12
            wait_irq = 0x10
        elif cmd == 0x0C:
            irq_en = 0x77
            wait_irq = 0x30

        self._wreg(0x02, irq_en | 0x80)
        self._cflags(0x04, 0x80)
        self._sflags(0x0A, 0x80)
        self._wreg(0x01, 0x00)

        for c in send:
            self._wreg(0x09, c)
        self._wreg(0x01, cmd)

        if cmd == 0x0C:
            self._sflags(0x0D, 0x80)

        i = 2000
        while True:
            n = self._rreg(0x04)
            i -= 1
            if ~((i != 0) and ~(n & 0x01) and ~(n & wait_irq)):
                break

        self._cflags(0x0D, 0x80)

        if i:
            if (self._rreg(0x06) & 0x1B) == 0x00:
                stat = self.OK

                if n & irq_en & 0x01:
                    stat = self.NOTAGERR
                elif cmd == 0x0C:
                    n = self._rreg(0x0A)
                    lbits = self._rreg(0x0C) & 0x07
                    if lbits != 0:
                        bits = (n - 1) * 8 + lbits
                    else:
                        bits = n * 8

                    if n == 0:
                        n = 1
                    elif n > 16:
                        n = 16

                    if into is None:
                        recv = self.recvBuf
                    else:
                        recv = into
                    pos = 0
                    while pos < n:
                        recv[pos] = self._rreg(0x09)
                        pos += 1
                    if into is None:
                        recv = self.recvMv[:n]
                    else:
                        recv = into

            else:
                stat = self.ERR

        return stat, recv, bits

    def _assign_crc(self, data, count):

        self._cflags(0x05, 0x04)
        self._sflags(0x0A, 0x80)

        dataPos = 0
        while dataPos < count:
            self._wreg(0x09, data[dataPos])
            dataPos += 1

        self._wreg(0x01, 0x03)

        i = 0xFF
        while True:
            n = self._rreg(0x05)
            i -= 1
            if not ((i != 0) and not (n & 0x04)):
                break

        data[count] = self._rreg(0x22)
        data[count + 1] = self._rreg(0x21)

    def init(self):

        self.reset()
        self._wreg(0x2A, 0x8D)
        self._wreg(0x2B, 0x3E)
        self._wreg(0x2D, 30)
        self._wreg(0x2C, 0)
        self._wreg(0x15, 0x40)
        self._wreg(0x11, 0x3D)
        self.set_gain(self.MAX_GAIN)
        self.antenna_on()


    def reset(self):
        self._wreg(0x01, 0x0F)

    def antenna_on(self, on=True):

        if on and ~(self._rreg(0x14) & 0x03):
            self._sflags(0x14, 0x03)
        else:
            self._cflags(0x14, 0x03)

    def request(self, mode):

        self._wreg(0x0D, 0x07)
        (stat, recv, bits) = self._tocard(0x0C, [mode])

        if (stat != self.OK) | (bits != 0x10):
            stat = self.ERR

        return stat, bits

    def anticoll(self):

        ser_chk = 0
        ser = [0x93, 0x20]

        self._wreg(0x0D, 0x00)
        (stat, recv, bits) = self._tocard(0x0C, ser)

        if stat == self.OK:
            if len(recv) == 5:
                for i in range(4):
                    ser_chk = ser_chk ^ recv[i]
                if ser_chk != recv[4]:
                    stat = self.ERR
            else:
                stat = self.ERR

        # CH Note bytearray allocation here
        return stat, bytearray(recv)

    def select_tag(self, ser):
        # TODO CH normalise all list manipulation to bytearray, avoid below allocation
        buf = bytearray(9)
        buf[0] = 0x93
        buf[1] = 0x70
        buf[2:7] = ser
        self._assign_crc(buf, 7)
        (stat, recv, bits) = self._tocard(0x0C, buf)
        return self.OK if (stat == self.OK) and (bits == 0x18) else self.ERR

    def auth(self, mode, addr, sect, ser):
        # TODO CH void ser[:4] implicit list allocation
        buf = self.authBuf
        buf[0]=mode # A or B
        buf[1]=addr # block
        buf[2:8]=sect # key bytes
        buf[8:12]=ser[:4] # 4 bytes of id
        return self._tocard(0x0E, buf)[0]

    # TODO this may well need to be implemented for vault to properly back out from a card session
    # TODO how, why, when is 'HaltA' needed? see https://github.com/cefn/micropython-mfrc522/issues/1
    def halt_a(self):
        pass

    def stop_crypto1(self):
        self._cflags(0x08, 0x08)

    def set_gain(self, gain):
        assert gain <= self.MAX_GAIN
        # clear bits
        self._cflags(self.GAIN_REG, 0x07<< 4)
        # set bits according to gain
        self._sflags(self.GAIN_REG, gain << 4)

    def read(self, addr, into = None):
        buf = self.regBuf
        buf[0]=0x30
        buf[1]=addr
        self._assign_crc(buf, 2)
        (stat, recv, _) = self._tocard(0x0C, buf, into=into)
        # TODO this logic probably wrong (should be 'into is None'?)
        if into is None: # superstitiously avoid returning read buffer memoryview
            # CH Note bytearray allocation here
            recv = bytearray(recv)
        return recv if stat == self.OK else None

    def write(self, addr, data):
        buf = self.regBuf
        buf[0] = 0xA0
        buf[1] = addr
        self._assign_crc(buf, 2)
        (stat, recv, bits) = self._tocard(0x0C, buf)

        if not (stat == self.OK) or not (bits == 4) or not ((recv[0] & 0x0F) == 0x0A):
            stat = self.ERR
        else:
            buf = self.blockWriteBuf

            i = 0
            while i < 16:
                buf[i] = data[i]  # TODO CH eliminate this, accelerate it?
                i += 1

            self._assign_crc(buf, 16)
            (stat, recv, bits) = self._tocard(0x0C, buf)
            if not (stat == self.OK) or not (bits == 4) or not ((recv[0] & 0x0F) == 0x0A):
                stat = self.ERR

        return stat
