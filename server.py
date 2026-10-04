"""Serve the local workspace UI and JSON API."""
import json
import mimetypes
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse
from workspace import ROOT, DATA_DIR, DB_PATH, db, bootstrap, issue_row
import workspace
import snapshot


class Handler(BaseHTTPRequestHandler):
    server_version="LinearClone/1.0"

    def log_message(self,fmt,*args):
        if os.environ.get("CLONE_ACCESS_LOG")=="1":super().log_message(fmt,*args)

    def send_json(self,data,status=200):
        raw=json.dumps(data,ensure_ascii=False,default=str).encode("utf-8")
        self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(raw)));self.send_header("Cache-Control","no-store")
        self.end_headers();self.wfile.write(raw)

    def body(self):
        size=int(self.headers.get("Content-Length",0))
        if size>5_000_000:raise ValueError("Request body too large")
        raw=self.rfile.read(size) if size else b"{}"
        return json.loads(raw.decode("utf-8")) if raw else {}

    def do_OPTIONS(self):
        self.send_response(204);self.end_headers()

    def do_GET(self):
        parsed=urlparse(self.path);path=unquote(parsed.path);query=parse_qs(parsed.query)
        if path.startswith("/api/"):self.api_get(path,query);return
        target=(ROOT/("index.html" if path=="/" else path.lstrip("/"))).resolve()
        # Only serve first-party UI files; never expose the SQLite database or
        # other workspace files through the static-file handler.
        if target.parent!=ROOT or target.name not in {"index.html","styles.css","app.js"}:self.send_error(404);return
        if not target.exists() or target.is_dir():self.send_error(404);return
        content=target.read_bytes();kind=mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        content_type=kind+("; charset=utf-8" if kind.startswith("text/") or kind in ("application/javascript","application/json") else "")
        self.send_response(200);self.send_header("Content-Type",content_type);self.send_header("Content-Length",str(len(content)));self.end_headers();self.wfile.write(content)

    def do_POST(self):self.api_mutate("POST")
    def do_PUT(self):self.api_mutate("PUT")
    def do_PATCH(self):self.api_mutate("PATCH")
    def do_DELETE(self):self.api_mutate("DELETE")

    def api_get(self,path,query):
        with snapshot.locked():
            try:
                self.api_get_locked(path,query)
            except snapshot.SyncConflict as error:
                self.send_json({"error":str(error)},409)
            except snapshot.PendingExport as error:
                self.send_json({"error":str(error),"committed":True},503)
            except ValueError as error:
                self.send_json({"error":str(error)},400)

    def api_get_locked(self,path,query):
        con=db()
        try:
            snapshot.recover(con)
            con.execute("BEGIN")
            if path=="/api/bootstrap":return self.send_json(bootstrap(con))
            attachment_match=re.fullmatch(r"/api/attachments/(\d+)",path)
            if attachment_match:
                attachment_id=int(attachment_match.group(1))
                row=con.execute("SELECT * FROM issue_attachments WHERE id=?",(attachment_id,)).fetchone()
                if not row:return self.send_json({"error":"Attachment not found"},404)
                target=(DATA_DIR/"attachments"/row["storage_name"]).resolve()
                if target.parent!=(DATA_DIR/"attachments").resolve() or not target.is_file():return self.send_json({"error":"Attachment file not found"},404)
                content=target.read_bytes();fallback=re.sub(r"[^A-Za-z0-9._-]","_",row["name"]) or "attachment"
                self.send_response(200);self.send_header("Content-Type",row["content_type"]);self.send_header("Content-Length",str(len(content)))
                self.send_header("Content-Disposition",f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(row['name'])}")
                self.send_header("X-Content-Type-Options","nosniff");self.send_header("Cache-Control","no-store");self.end_headers();self.wfile.write(content);return
            if path=="/api/export":
                result=bootstrap(con);result["exportedAt"]=now();return self.send_json(result)
            if path=="/api/search":
                return self.send_json(workspace.search(con,query.get("q",[""])[0],query.get("scope",["All"])[0]))
            if path.startswith("/api/issues/"):
                ident=path.split("/")[3];row=con.execute("SELECT id FROM issues WHERE identifier=?",(ident,)).fetchone()
                if not row:return self.send_json({"error":"Issue not found"},404)
                return self.send_json(issue_row(con,row[0]))
            if path.startswith("/api/projects/"):
                pid=int(path.split("/")[3]);p=next((p for p in bootstrap(con)["projects"] if p["id"]==pid),None)
                if not p:return self.send_json({"error":"Project not found"},404)
                return self.send_json(p)
            if path=="/api/health":return self.send_json({"ok":True,"database":"sqlite","mode":"local-single-user"})
            return self.send_json({"error":"Not found"},404)
        finally:con.close()

    def api_mutate(self,method):
        path=unquote(urlparse(self.path).path)
        try:data=self.body()
        except (ValueError,json.JSONDecodeError) as e:return self.send_json({"error":str(e)},400)
        con=db()
        try:
            result=snapshot.mutate(method,path,data,con=con)
            status=result.pop("_status",200);self.send_json(result,status)
        except KeyError as e:
            con.rollback();self.send_json({"error":f"Missing field: {e.args[0]}"},400)
        except ValueError as e:
            con.rollback();self.send_json({"error":str(e)},400)
        except snapshot.SyncConflict as e:
            con.rollback();self.send_json({"error":str(e)},409)
        except snapshot.PendingExport as e:
            self.send_json({"error":str(e),"committed":True},503)
        except sqlite3.IntegrityError as e:
            con.rollback();self.send_json({"error":f"Conflict or invalid relationship: {e}"},409)
        except Exception as e:
            con.rollback();self.send_json({"error":"Internal error","detail":str(e)},500)
        finally:con.close()

def recurring_worker():
    while True:
        try:
            snapshot.run_recurring()
        except Exception as error:
            print(f"Recurring issue scheduler error: {error}", flush=True)
        time.sleep(30)


def main():
    global DATA_DIR, DB_PATH
    DATA_DIR, DB_PATH = workspace.DATA_DIR, workspace.DB_PATH
    if not DB_PATH.exists():
        if workspace.SNAPSHOT_DIR.exists():
            raise ValueError("Snapshot found. Run python3 cli.py sync import first.")
        snapshot.initialize(demo=True)
    else:
        snapshot.prepare()
    host=os.environ.get("CLONE_HOST","127.0.0.1");port=int(os.environ.get("PORT","4173"))
    print(f"Linear-style workspace running at http://{host}:{port} (SQLite: {DB_PATH})",flush=True)
    threading.Thread(target=recurring_worker,name="recurring-issue-scheduler",daemon=True).start()
    ThreadingHTTPServer((host,port),Handler).serve_forever()


if __name__=="__main__":main()
