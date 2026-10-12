import http.client
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import soniox_utils
class Response:
    def __init__(self,error=None):self.error=error
    def __enter__(self):return self
    def __exit__(self,*args):return False
    def read(self):
        if self.error:raise self.error
        return b'{"tokens":[]}'
class HttpRecoveryTests(unittest.TestCase):
    def test_get_read_failure_retries_same_url_without_any_mutation(self):
        with patch.object(soniox_utils.urllib.request,'urlopen',side_effect=[Response(http.client.IncompleteRead(b'a',2)),Response()]) as call,patch.object(soniox_utils.time,'sleep'):
            self.assertEqual(soniox_utils.http_json('https://example.invalid/transcript',key='fixture'),{'tokens':[]})
            self.assertEqual(call.call_count,2)
            self.assertTrue(all(c.args[0].get_method()=='GET' for c in call.call_args_list))
    def test_post_and_delete_are_never_retried(self):
        for method in ['POST','DELETE']:
            with self.subTest(method=method),patch.object(soniox_utils.urllib.request,'urlopen',return_value=Response(http.client.IncompleteRead(b'a',2))) as call:
                with self.assertRaises(http.client.IncompleteRead):soniox_utils.http_json('https://example.invalid',key='fixture',method=method)
                self.assertEqual(call.call_count,1)
    def test_get_retries_are_bounded(self):
        with patch.object(soniox_utils.urllib.request,'urlopen',return_value=Response(http.client.IncompleteRead(b'a',2))) as call,patch.object(soniox_utils.time,'sleep'):
            with self.assertRaises(http.client.IncompleteRead):soniox_utils.http_json('https://example.invalid',key='fixture')
            self.assertEqual(call.call_count,3)
if __name__=='__main__':unittest.main()
