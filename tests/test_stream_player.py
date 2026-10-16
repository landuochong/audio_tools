import threading
import time
import unittest
from types import SimpleNamespace
import numpy as np
import sounddevice as sd
import soxr
from app.stream_player import StreamPlayer, AudioBuffer


def device_query(device):
    return {'default_samplerate':48000,'max_output_channels':2}


class FakeStream:
    instances=[]
    def __init__(self, **kwargs):
        self.options=kwargs;self.data=[];self.closed=False;self.abort_event=threading.Event()
        self.instances.append(self)
    def start(self):
        def run():
            try:
                while not self.abort_event.is_set():
                    block=np.empty((257,2),dtype=np.float32)
                    try:
                        self.options['callback'](block,257,None,SimpleNamespace(output_underflow=False))
                    except sd.CallbackStop:
                        self.data.append(block.copy());break
                    except sd.CallbackAbort: break
                    self.data.append(block.copy())
                    time.sleep(.001)
            finally:self.options['finished_callback']()
        self.thread=threading.Thread(target=run);self.thread.start()
    def stop(self):self.thread.join()
    def abort(self):self.abort_event.set();self.thread.join()
    def close(self):self.closed=True


class StreamTests(unittest.TestCase):
    def setUp(self):FakeStream.instances=[]
    def player(self, stopped=None, factory=FakeStream):
        return StreamPlayer([1],stopped or threading.Event(),factory,device_query=device_query)
    def test_continuous_resampling_matches_whole_signal(self):
        x=(np.sin(np.arange(24000)*.17)*10000).astype('<i2')
        player=self.player()
        for chunk in np.array_split(x,7):player.append(chunk.tobytes(),24000)
        player.finish();player.finish()
        stream=FakeStream.instances[0];actual=np.concatenate(stream.data)
        expected=soxr.resample(x.astype(np.float32)/32768,24000,48000,quality='HQ')
        np.testing.assert_allclose(actual[:len(expected),0],expected,atol=1e-6)
        np.testing.assert_array_equal(actual[:,0],actual[:,1])
        self.assertTrue(np.all(actual[len(expected):]==0))
        self.assertEqual(stream.options['samplerate'],48000)
        self.assertEqual(player.underflows,0)
        self.assertTrue(stream.closed)
    def test_waits_for_prebuffer(self):
        player=self.player();player.append(b'\1\0'*19200,24000)
        time.sleep(.05);self.assertEqual(FakeStream.instances,[])
        player.finish();self.assertEqual(len(FakeStream.instances),1)
    def test_stop_during_prebuffer_discards_audio(self):
        stopped=threading.Event();player=self.player(stopped);player.append(b'\1\0'*100,24000)
        stopped.set();player.finish();self.assertEqual(FakeStream.instances,[])
    def test_device_error_propagates(self):
        def broken(**kwargs):raise RuntimeError('unplugged')
        player=self.player(factory=broken);player.append(b'\1\0'*100,24000)
        with self.assertRaisesRegex(RuntimeError,'unplugged'):player.finish()
    def test_short_tail_kept(self):
        player=self.player();player.append(b'\1\0'*100,48000);player.finish()
        actual=np.concatenate(FakeStream.instances[0].data)
        np.testing.assert_array_equal(actual[:100,0],np.ones(100)/32768)
        self.assertTrue(np.all(actual[100:]==0))
    def test_callback_spans_chunks_without_gaps(self):
        b=AudioBuffer();b.append(np.array([1,2],dtype=np.float32));b.append(np.array([3,4,5],dtype=np.float32));b.finish()
        first=np.empty((3,2),dtype=np.float32);last=np.empty((3,2),dtype=np.float32)
        self.assertEqual(b.read_into(first),(3,False));self.assertEqual(b.read_into(last),(2,True))
        np.testing.assert_array_equal(first[:,0],[1,2,3]);np.testing.assert_array_equal(last[:,0],[4,5,0])
    def test_callback_distinguishes_starvation_from_eof(self):
        b=AudioBuffer();out=np.ones((5,2),dtype=np.float32)
        self.assertEqual(b.read_into(out),(0,False));self.assertTrue(np.all(out==0))
        b.finish();self.assertEqual(b.read_into(out),(0,True))
