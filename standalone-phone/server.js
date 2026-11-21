import http from 'node:http';
import { WebSocketServer } from 'ws';

const port=Number(process.env.PORT||8787);
const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,service:'standalone-phone-bridge'}));}
  res.writeHead(404);res.end('not found');
});
const wss=new WebSocketServer({server,path:'/asterisk-media'});
wss.on('connection',ws=>{
  let started=false;
  ws.on('message',(data,isBinary)=>{
    if(isBinary){ if(started) {/* caller audio hook: STT will attach here */} return; }
    let msg; try{msg=JSON.parse(data.toString())}catch{return}
    if(msg.event==='MEDIA_START'){
      started=true;
      console.info('[media] started',{channel:msg.channel_id,format:msg.format,ptime:msg.ptime});
      ws.send(JSON.stringify({command:'SET_MEDIA_DIRECTION',direction:'both'}));
    }
  });
});
server.listen(port,'0.0.0.0',()=>console.log('standalone phone bridge listening',port));
