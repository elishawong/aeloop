#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.CONDUCTOR_WORK_PORT??4173);
const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"};
http.createServer((request,response)=>{const requested=request.url==="/"?"/index.html":request.url??"/index.html";const file=path.resolve(root,`.${requested}`);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){response.writeHead(404).end("Not found");return}response.writeHead(200,{"Content-Type":types[path.extname(file)]??"application/octet-stream"});fs.createReadStream(file).pipe(response)}).listen(port,"127.0.0.1",()=>console.log(`Conductor Work UI: http://127.0.0.1:${port}`));
