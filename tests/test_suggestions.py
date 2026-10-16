import json
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi.testclient import TestClient
from app.main import app
from app import suggestions as module


class SuggestionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url='http://127.0.0.1:8030')

    def test_invalid_input_never_reaches_model(self):
        with patch.object(module, 'local_post', new_callable=AsyncMock) as call:
            for data in ({'conversation':'a'*6001}, {'conversation':'你好','relationship':'未知'}):
                self.assertEqual(self.client.post('/api/suggestions', json=data).status_code,422)
            call.assert_not_awaited()

    def test_foreign_webpage_cannot_submit_chat(self):
        response=self.client.post('/api/suggestions',json={'conversation':'你好'},headers={'origin':'https://example.com'})
        self.assertEqual(response.status_code,403)

    def test_local_model_returns_three_drafts_without_playback(self):
        content=json.dumps({'suggestions':[{'text':s} for s in ['今天辛苦了，先歇一会儿。','想说的话，我听着。','要不要聊点轻松的？']]})
        with patch.object(module, 'local_post', new_callable=AsyncMock, side_effect=[{}, {'message':{'content':content}}]) as call:
            result=self.client.post('/api/suggestions',json={'conversation':'对方：好累','intention':'想关心一下'})
            self.assertEqual(result.status_code,200)
            self.assertEqual([x['style'] for x in result.json()['suggestions']],module.STYLES)
            request=call.call_args_list[1].args[1]
            self.assertFalse(request['stream'])
            self.assertEqual(request['messages'][0]['role'],'system')
            self.assertIn('对方：好累',request['messages'][1]['content'])
            self.assertTrue(result.json()['local'])

    def test_cloud_alias_rejected_before_chat_sent(self):
        with patch.object(module,'local_post',new_callable=AsyncMock,return_value={'remote_model':'remote','remote_host':'https://ollama.com'}) as call:
            self.assertEqual(self.client.post('/api/suggestions',json={'conversation':'秘密'}).status_code,503)
            self.assertEqual(call.await_count,1)
            self.assertEqual(call.call_args.args[0],'/api/show')

    def test_cloud_model_name_rejected_without_network(self):
        with patch.object(module,'MODEL','example:cloud'), patch.object(module,'local_post',new_callable=AsyncMock) as call:
            self.assertEqual(self.client.post('/api/suggestions',json={'conversation':'秘密'}).status_code,503)
            call.assert_not_awaited()

    def test_malformed_and_duplicate_replies_are_not_shown(self):
        for content in ['oops',json.dumps({'suggestions':[{'text':'重复'}]*3})]:
            with patch.object(module,'local_post',new_callable=AsyncMock,side_effect=[{}, {'message':{'content':content}}]):
                self.assertEqual(self.client.post('/api/suggestions',json={'conversation':'你好'}).status_code,502)

    def test_unavailable_model_has_actionable_error(self):
        with patch.object(module,'local_post',new_callable=AsyncMock,side_effect=httpx.ConnectError('sensitive internal detail')):
            result=self.client.post('/api/suggestions',json={'conversation':'你好'})
            self.assertEqual(result.status_code,503)
            self.assertNotIn('sensitive',result.text)
            self.assertFalse(self.client.get('/api/suggestions/status').json()['ready'])

    def test_empty_or_whitespace_context_generates_greetings(self):
        content=json.dumps({'suggestions':[{'text':s} for s in ['嗨，你好呀。','最近过得怎么样？','想跟你打个招呼。']]})
        for payload in ({}, {'conversation':''}, {'conversation':'  \n '}):
            with patch.object(module,'local_post',new_callable=AsyncMock,side_effect=[{}, {'message':{'content':content}}]) as call:
                result=self.client.post('/api/suggestions',json=payload)
                self.assertEqual(result.status_code,200)
                self.assertEqual(len(result.json()['suggestions']),3)
                prompt=call.call_args_list[1].args[1]['messages'][0]['content']
                self.assertIn(module.GREETING,prompt)

    def test_string_array_from_model_is_normalized(self):
        content=json.dumps({'suggestions':['嗨，你好呀。','最近怎么样？','想跟你聊聊天。']})
        with patch.object(module,'local_post',new_callable=AsyncMock,side_effect=[{}, {'message':{'content':content}}]):
            result=self.client.post('/api/suggestions',json={})
            self.assertEqual(result.status_code,200)
            self.assertEqual(result.json()['suggestions'][0]['text'],'嗨，你好呀。')
