import io
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from app import main


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, base_url='http://127.0.0.1:8030')
        main.clips.clear()

    def test_foreign_origin_cannot_play(self):
        response = self.client.post('/api/stop', headers={'origin': 'https://example.com'})
        self.assertEqual(response.status_code, 403)

    def test_local_ui_loads(self):
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_missing_audio_is_not_played(self):
        response = self.client.post('/api/play', json={'clip_id':'missing', 'devices':[1]})
        self.assertEqual(response.status_code, 404)

    def test_text_length_and_empty_validation(self):
        self.assertEqual(self.client.post('/api/synthesize', json={'text': 'x'*501}).status_code, 422)
        self.assertEqual(self.client.post('/api/synthesize', json={'text': ' '}).status_code, 400)

    def test_device_disconnect_rejected_before_playback(self):
        main.clips['test'] = (b'wav', np.zeros((160, 1), dtype=np.float32), 16000)
        with patch.object(main, 'list_outputs', return_value=[{'id':1}]):
            response = self.client.post('/api/play', json={'clip_id':'test', 'devices':[22]})
        self.assertEqual(response.status_code, 400)

    def test_audio_download_is_wav(self):
        stream=io.BytesIO();sf.write(stream,np.zeros(160),16000,format='WAV')
        main.clips['test']=(stream.getvalue(),np.zeros((160,1)),16000)
        response=self.client.get('/api/audio/test')
        self.assertEqual(response.headers['content-type'],'audio/wav')
        self.assertEqual(response.content[:4],b'RIFF')

    def test_no_route_selected_rejected(self):
        response=self.client.post('/api/play',json={'clip_id':'test','devices':[]})
        self.assertEqual(response.status_code,422)


if __name__=='__main__': unittest.main()
