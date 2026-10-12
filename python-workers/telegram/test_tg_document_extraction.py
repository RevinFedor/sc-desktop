import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).parent))
import tg_document_extraction as doc
import telegram_archive_media as media


class ExtractionTests(unittest.TestCase):
    def test_tsv_unicode_layout_and_confidence_not_coverage_proof(self):
        header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
        raw=header+'5\t1\t1\t1\t1\t1\t0\t0\t20\t20\t90\tСети\n'+'5\t1\t1\t1\t1\t2\t0\t0\t20\t20\t80\tлекции\n'
        text, quality=doc.tsv_text(raw.encode())
        self.assertEqual(text,'Сети лекции'); self.assertEqual(quality['mean_confidence'],85)
        self.assertTrue(quality['confidence_is_not_coverage_proof'])
        with self.assertRaises(ValueError):doc.tsv_text('Plain OCR text is not TSV'.encode())

    def test_invalid_native_utf8_ocr_bounded_raster_and_partial_not_replacement(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root)/'page'; calls=[]
            def command(argv, timeout):
                calls.append(argv)
                if argv[0]=='pdftotext':return SimpleNamespace(stdout=b'valid\xed\xbf\x81invalid')
                if argv[0]=='pdftoppm':
                    from PIL import Image
                    Image.new('RGB',(80,100),'white').save(argv[-1]+'.png')
                    return SimpleNamespace(stdout=b'')
                raise AssertionError(argv)
            with patch.object(doc,'ocr',return_value=('Оригинальный восстановленный текст',{'method':'offline_tesseract_rus_eng'})):
                out=doc.pdf_page(Path(root)/'x.pdf',2,directory,None,command=command)
            self.assertEqual(out['native_decode_error']['bad_bytes'],'ed')
            self.assertEqual(Path(out['raw_native_path']).read_bytes(),b'valid\xed\xbf\x81invalid')
            self.assertIn('OCR_not_glyph_complete_or_visual_semantics_verified',[g['reason'] for g in out['gaps']])
            self.assertIn('-scale-to',calls[1]); self.assertEqual(calls[1][calls[1].index('-scale-to')+1],'2400')
            self.assertNotIn('\ufffd',Path(out['text_path']).read_text())

    def test_native_valid_page_reuse_no_second_tool_and_hash_change_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            directory=Path(root)/'page'
            def command(argv, timeout):return SimpleNamespace(stdout=('Полный native текст страницы. '*4).encode())
            out=doc.pdf_page(Path(root)/'x.pdf',1,directory,None,command=command)
            self.assertEqual(doc.pdf_page(Path(root)/'x.pdf',1,directory,None,command=lambda *a: self.fail('must reuse')),out)
            Path(out['text_path']).write_text('changed')
            with self.assertRaises(ValueError):doc.cache_read(directory)

    def test_total_deadline_partial_no_tool_hidden_retry(self):
        with tempfile.TemporaryDirectory() as root:
            original=Path(root)/'x.pdf';original.write_bytes(b'fixture')
            with patch.object(doc,'run',return_value=SimpleNamespace(stdout=b'Pages: 31\n')):
                result=doc.extract(original,Path(root)/'out',doc.sha(original),seconds=0)
            self.assertEqual(result['pages_total'],31);self.assertEqual(result['pages_extracted'],0)
            self.assertEqual(result['state'],'original_verified_text_partial')
            self.assertEqual(result['gaps'][0]['reason'],'document_deadline')

    def test_unsafe_encrypted_drive_slip_and_symlink_never_opened(self):
        for name in ['/abs','../bad','C:\\unsafe','a\\..\\bad']:
            self.assertFalse(doc.safe_member(zipfile.ZipInfo(name)))
        entry=zipfile.ZipInfo('link');entry.external_attr=0o120777<<16
        self.assertFalse(doc.safe_member(entry));entry=zipfile.ZipInfo('enc');entry.flag_bits=1
        self.assertFalse(doc.safe_member(entry))

    def test_archive_natural_order_utf8_text_crc_and_unsupported_explicit(self):
        with tempfile.TemporaryDirectory() as root:
            original=Path(root)/'x.zip'
            with zipfile.ZipFile(original,'w') as z:
                z.writestr('10.txt','ten');z.writestr('2.txt','two');z.writestr('1.txt','one');z.writestr('run.exe',b'binary')
            result=doc.extract(original,Path(root)/'out',doc.sha(original))
            self.assertEqual([p['member'] for p in result['pages']],['1.txt','2.txt','10.txt'])
            self.assertTrue(all(p['crc_checked'] for p in result['pages']))
            self.assertEqual(result['state'],'original_verified_text_partial')
            self.assertEqual(result['gaps'][0]['reason'],'binary_member_unsupported')

    def test_original_changed_and_unsupported_format_do_not_publish(self):
        with tempfile.TemporaryDirectory() as root:
            original=Path(root)/'x.mp3';original.write_bytes(b'fixture')
            with self.assertRaises(ValueError):doc.extract(original,Path(root)/'out','a'*64)
            with self.assertRaises(ValueError):doc.extract(original,Path(root)/'out',doc.sha(original))

    def test_archive_admitted_images_local_only_partial(self):
        with tempfile.TemporaryDirectory() as root:
            from PIL import Image
            image=io.BytesIO();Image.new('RGB',(100,300),'white').save(image,format='JPEG')
            original=Path(root)/'x.zip'
            with zipfile.ZipFile(original,'w') as z:z.writestr('1.jpg',image.getvalue())
            with patch.object(doc,'ocr',return_value=('Локальный OCR',{'method':'offline_tesseract_rus_eng'})):
                result=doc.extract(original,Path(root)/'out',doc.sha(original))
            self.assertEqual(result['pages_extracted'],1);self.assertEqual(result['paid_calls'],0)
            self.assertEqual(result['state'],'original_verified_text_partial')

    def test_stable_outputs_preserved_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'out.txt';doc.stable(path,'one')
            with self.assertRaises(ValueError):doc.stable(path,'two')
            self.assertEqual(path.read_text(),'one')


class RetryFences(unittest.TestCase):
    def setup_fixture(self, root):
        root=Path(root);(root/'tmp').mkdir()
        receipt=root/'same.json'; original=root/'original.pdf';original.write_bytes(b'original')
        prepared=root/'tmp'/'prepared.json'
        prepared.write_text(json.dumps({'job_id':'same','prepared_only':True,'db_job_id':1,'session':'session_test','expected_account_id':11,'rows':[{'item_id':1}],'item_ids':[1]}))
        receipt.write_text(json.dumps({'job_id':'same','pid':None,'db_job_id':1,'session':'session_test','expected_account_id':11}))
        args=SimpleNamespace(job_id='same',prepared_manifest=str(prepared),after_index_job='index-123')
        return receipt,prepared,args

    def test_live_controller_and_running_or_wrong_index_never_open_library(self):
        with tempfile.TemporaryDirectory() as root:
            receipt, prepared, args=self.setup_fixture(root)
            with patch.object(media,'app_root',return_value=Path(root)),patch.object(media,'key_path',return_value=receipt),patch.object(media,'open_db') as db:
                receipt.write_text(json.dumps({'pid':40550}))
                with self.assertRaises(ValueError):media.retry_document_extractions(args)
                db.assert_not_called()
            receipt.write_text(json.dumps({'pid':None,'db_job_id':1,'session':'session_test','expected_account_id':11}))
            for identity in [{'id':'index-123','status':'running'},{'id':'index-other','status':'done'}]:
                with patch.object(media,'app_root',return_value=Path(root)),patch.object(media,'key_path',return_value=receipt),patch.object(media,'public_call',return_value={'job':identity}) as read,patch.object(media,'open_db') as db:
                    with self.assertRaises(ValueError):media.retry_document_extractions(args)
                    db.assert_not_called()
                    read.assert_called_once_with('index/status?id=index-123')

    def test_no_publication_on_receipt_identity_mismatch_or_nonowned_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            receipt, prepared, args=self.setup_fixture(root)
            value=json.loads(prepared.read_text());value['expected_account_id']=99;prepared.write_text(json.dumps(value))
            with patch.object(media,'app_root',return_value=Path(root)),patch.object(media,'key_path',return_value=receipt),patch.object(media,'public_call') as network:
                with self.assertRaises(ValueError):media.retry_document_extractions(args)
                network.assert_not_called()

    def test_prepare_reads_own_original_only_no_library_or_paid_call(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); directory=root/'originals/telegram/session_test/1/10/same';directory.mkdir(parents=True)
            original=directory/'doc.pdf';original.write_bytes(b'original')
            receipt=root/'same.json';state={'job_id':'same','db_job_id':1,'session':'session_test','expected_account_id':11,
                'rows':[{'item_id':1,'source_id':1,'message_id':10,'kind':'document','original_path':str(original),
                         'original_sha256':doc.sha(original),'original_caption_sha256':'empty','state':'error'}]}
            receipt.write_text(json.dumps(state));before=receipt.read_bytes()
            (root/'tmp').mkdir();args=SimpleNamespace(job_id='same',item_ids='1',output_dir=str(root/'tmp'/'prepared'))
            result={'state':'original_verified_text_partial','pages_total':1,'pages_attempted':1,'pages_extracted':1,'chars':3,
                    'original_sha256':doc.sha(original),'text_sha256':'text','text_path':'fixture'}
            with patch.object(media,'app_root',return_value=root),patch.object(media,'key_path',return_value=receipt),patch.object(doc,'extract',return_value=result),patch.object(media,'open_db') as db,patch.object(media,'load') as paid:
                out=media.prepare_document_extractions(args)
                db.assert_not_called();paid.assert_not_called()
            self.assertTrue(out['prepared_only']);self.assertEqual(out['caption_mutations'],0)
            self.assertEqual(receipt.read_bytes(),before)

    def test_terminal_index_publication_and_checkpoint_reconciliation_same_receipt(self):
        from test_telegram_archive_media import ArchiveMediaTests
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);(root/'tmp').mkdir(); original=root/'doc.pdf';original.write_bytes(b'original')
            text=root/'tmp'/'full.txt';text.write_text('Recovered text')
            receipt=root/'same.json'; prepared=root/'tmp'/'prepared.json'
            state={'job_id':'same','pid':None,'db_job_id':1,'session':'session_test','expected_account_id':11,'sources':{},
                'rows':[{'item_id':1,'source_id':1,'message_id':10,'kind':'document','original_path':str(original),
                         'original_sha256':doc.sha(original),'original_caption_sha256':media.hashlib.sha256(b'').hexdigest(),'state':'error'}]}
            receipt.write_text(json.dumps(state))
            extraction={'policy':doc.POLICY,'original_sha256':doc.sha(original),'text_sha256':doc.sha(text),'text_path':str(text),
                        'pages_extracted':1,'state':'original_verified_text_partial'}
            prepared.write_text(json.dumps({'job_id':'same','prepared_only':True,'db_job_id':1,'session':'session_test','expected_account_id':11,'item_ids':[1],
                'rows':[{'item_id':1,'source_id':1,'message_id':10,'original_caption_sha256':state['rows'][0]['original_caption_sha256'],'extraction':extraction}]}))
            args=SimpleNamespace(job_id='same',prepared_manifest=str(prepared),after_index_job='index-123')
            c=ArchiveMediaTests().connection();ArchiveMediaTests().insert(c,kind='document',caption='')
            class NoClose:
                def __getattr__(self,name):return getattr(c,name)
                def close(self):pass
            with patch.object(media,'app_root',return_value=root),patch.object(media,'key_path',return_value=receipt),patch.object(media,'public_call',return_value={'job':{'id':'index-123','status':'done','source_id':1}}),patch.object(media,'source_ready_for_media',return_value=True),patch.object(media,'open_db',return_value=NoClose()):
                first=media.retry_document_extractions(args)
                caption=c.execute('SELECT caption FROM items WHERE id=1').fetchone()[0]
                self.assertEqual(caption,'[документ — извлечение · local-pdf] [частичное извлечение]\nRecovered text')
                self.assertEqual(first['new_provider_requests'],0)
                # Reproduce lost SAME receipt checkpoint after Library commit.
                receipt.write_text(json.dumps(state))
                again=media.retry_document_extractions(args)
                self.assertEqual(c.execute('SELECT caption FROM items WHERE id=1').fetchone()[0],caption)
                self.assertTrue(json.loads(receipt.read_text())['rows'][0]['extraction_recovery']['reconciled_commit'])
                self.assertEqual(again['new_downloads'],0)
            c.close()


if __name__=='__main__':unittest.main()
