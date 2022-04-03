import http from "http";
import cors from "cors";
import express, { Router } from "express";
import { WebSocket } from "ws";
import { ClientState } from "../../shared/dist/clients";
import {
  WsMessage,
  becomeReceiver,
  becomeSender,
  bvhFrame,
  joinRemoteFail,
  joinRemoteSuccess,
  remoteState,
  serialize,
  unbecomeReceiver,
} from "../../shared/dist/messages";
import { logger } from "./logging";
import "./types";

const app = express();

// state
///////////////////////////////////////////////////////////////////////////////
const state: ClientState = {
  clients: [],
  clientMap: [],
};

// apply middleware
///////////////////////////////////////////////////////////////////////////////
app.use(cors({ origin: ["http://localhost:8080"] }));
app.use(express.json()); // json body parser

// initialise websocket
///////////////////////////////////////////////////////////////////////////////
function handleDisconnect(ws: WebSocket, err?: any) {
  const clientName = ws.name;
  logger.info(`⚡ WS disconnected.`, clientName, err);

  const i = state.clients.findIndex((client) => client.name === clientName);
  if (i >= 0) {
    logger.info(`🕸 All mappings to and from ${state.clients[i].name} removed.`);
    state.clientMap.filterInPlace(([from, to]) => {
      return !(from.name === clientName || to.name === clientName);
    });

    logger.info(`💃 Client ${state.clients[i].name} removed.`);
    state.clients.splice(i, 1);
  }

  // send the client list and mappings to all UIs
  // const wsMsg = newMsg({ type: "remote_state", payload: remoteState() });
  wss.clients.forEach((ws) => ws.send(serialize(remoteState(state))));
  // wss.getUis().forEach((ws) => ws.send(serialize(remoteState(state))));
}

const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });
wss.on("connection", (ws) => {
  logger.info(`⚡ WS connected.`);

  // on disconnect remove this client and any mapping to or from the
  // disconnected socket.
  ws.on("close", () => {
    logger.info("⚡ WS closed.", ws.name);
    handleDisconnect(ws);
  });
  ws.on("disconnect", () => {
    logger.info("⚡ WS disconnected", ws.name);
    handleDisconnect(ws);
  });
  ws.on("error", (err) => {
    logger.info("⚡ Ws connection error.", err);
    handleDisconnect(ws, err);
  });

  // on receipt of a message pass it on to all mapped clients
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as WsMessage;

    switch (msg._tag) {
      case "bvh_frame":
        state.clientMap
          .filter(([from]) => from.name === msg.from)
          .forEach(([from, to]) => to.ws.send(serialize(bvhFrame(msg.frame, from.name))));
        break;

      // case "register_ui":
      //   logger.info(`🎨 UI registered.`);

      //   // monkey-patch the `ws` to include the name so we can find the client later
      //   // when this socket disoconnects
      //   ws.name = "ui";

      //   // send ui a confirmation message)
      //   // TODO: is this even needed?
      //   // ws.send(newMsg({ type: "registration_success", payload: remoteState() }));
      //   break;

      case "join_remote":
        const name = msg.name as string;

        // has this name already been taken?
        const nameTaken = state.clients.find((client) => client.name === name);
        if (nameTaken) {
          ws.send(serialize(joinRemoteFail("name taken")));
          return;
        }

        // add the client
        logger.info(`💃 Client ${name} joined.`);
        state.clients.push({ name, ws });

        // monkey-patch the `ws` to include the name so we can find the client later
        // when this socket disoconnects
        ws.name = name;

        // send the client a response to say joining was successful
        ws.send(serialize(joinRemoteSuccess(name)));

        // send the client list and mappings to all UIs
        wss.clients.forEach((ws) => ws.send(serialize(remoteState(state))));
        // wss.getUis().forEach((ws) => ws.send(serialize(remoteState(state))));
        break;
    }
  });
});

// initialise routes
///////////////////////////////////////////////////////////////////////////////////////////////////
const router = Router();

router.get("/status", (req, res) => {
  res.send({ wsConnections: wss.clients.size, state: remoteState(state) });
});

router.put("/rename/:oldName", (req, res) => {
  const oldName = req.params.oldName;
  const newName = req.body.newName as string;

  // find the old name
  const oldClient = state.clients.find((client) => client.name === oldName);
  if (oldClient) {
    logger.info(`✏️ Renamed client from ${oldName} to ${newName}.`);
    oldClient.name = newName;

    // send the client a success message
    oldClient.ws.send(JSON.stringify({ type: "rename_success", payload: newName }));

    // send the client list and mappings to all UIs
    wss.clients.forEach((ws) => ws.send(serialize(remoteState(state))));
    // wss.getUis().forEach((ws) => ws.send(serialize(remoteState(state))));

    res.send();
  } else {
    res.status(500).send(`unable to find client with name ${oldName}`);
  }
});

router.get("/leave/:name", (req, res) => {
  const nameToRemove = req.params.name;

  // find the connection with the given name and close it.
  state.clients.find(({ name }) => name === nameToRemove)?.ws.close();

  res.send();
});

router.put("/map", (req, res) => {
  const fromName = req.body.fromName as string;
  const toName = req.body.toName as string;

  // does the first client (from) exist?
  const fromClient = state.clients.find((client) => client.name === fromName);
  if (!fromClient) {
    res.sendStatus(404).send(`no client with name ${fromName} found.`);
    return;
  }

  // does the second client (to) exist?
  const toClient = state.clients.find((client) => client.name === toName);
  if (!toClient) {
    res.sendStatus(404).send(`no client with name ${toName} found.`);
    return;
  }

  // does the mapping already exist
  const mapping = state.clientMap.find(([from, to]) => {
    return from.name === fromName && to.name === toName;
  });
  if (mapping) {
    res.sendStatus(500).send(`mapping already exists`);
    return;
  }

  logger.info(`🕸 Mapped ${fromClient.name} -> ${toClient.name}.`);
  state.clientMap.push([fromClient, toClient]);

  // send message to 'from' to set up as a sender
  fromClient.ws.send(serialize(becomeSender(toClient.name)));

  // send message to 'to' to setup as a receiver
  toClient.ws.send(serialize(becomeReceiver(fromClient.name)));

  // send the client list and mappings to all UIs
  wss.clients.forEach((ws) => ws.send(serialize(remoteState(state))));
  // wss.getUis().forEach((ws) => ws.send(serialize(remoteState(state))));

  res.send();
});

router.put("/unmap", (req, res) => {
  const fromName = req.body.fromName as string;
  const toName = req.body.toName as string;

  // does the mapping already exist
  const mappingIdx = state.clientMap.findIndex(([from, to]) => {
    return from.name === fromName && to.name === toName;
  });
  if (mappingIdx < 0) {
    res.sendStatus(404).send(`mapping does not exists`);
    return;
  }

  const [from, to] = state.clientMap[mappingIdx];

  state.clientMap.splice(mappingIdx, 1);

  // send the client list and mappings to all UIs
  wss.clients.forEach((ws) => ws.send(serialize(remoteState(state))));
  // wss.getUis().forEach((ws) => ws.send(serialize(remoteState(state))));

  // send message to 'to' to remove receiver
  to.ws.send(serialize(unbecomeReceiver(from.name)));

  res.send();
});

app.use("/api", router);

// start the Express server
///////////////////////////////////////////////////////////////////////////////
const port = 3000; // default port to listen on
httpServer.listen(port, () => {
  logger.info(`🎉 Remote streamer started at http://localhost:${port}`);
});
