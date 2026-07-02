# Friends Poker

A private browser-based Texas Hold'em table for friends. It uses play chips only and includes realtime game state, text chat, and WebRTC voice chat signaling.

## Run Locally

```powershell
npm start
```

Then open:

```text
http://localhost:3000
```

Create a room, share the room code with friends on the same hosted URL, and start a hand once at least two players have joined.

## Version 1 Features

- Private room codes
- 2-10 player Texas Hold'em tables
- Numbered seats from 1-10, with a compact square table layout
- Player-selected buy-in chips when joining
- Play chips with blinds, betting rounds, folds, calls, raises, all-in, and showdown hand ranking
- Separate total pot and current-round pot display
- Tens display as `10` instead of poker shorthand `T`
- Showdown reveals only winner cards automatically; other players can choose to show their cards
- Away/back mode for player breaks
- Owner pause/resume control
- Reconnect support from the same browser using a stored seat token
- Rebuy/chip requests when players run out, approved by the room owner
- Room player stats for hands, wins, buy-ins, chips added, and chips won
- Game sounds for dealing, chips, turns, and wins
- Text chat
- Browser voice chat using microphone permission and peer-to-peer WebRTC
- Turn timer with automatic fold/check behavior
- Responsive table layout for desktop and mobile

## Notes

Rooms are currently stored in memory, so restarting the server clears active games. Voice chat works best over `localhost` or HTTPS-hosted deployments because browsers restrict microphone access on insecure public origins.

For online deployment, the next best step is to add a small database or Redis store for room persistence, run the app behind HTTPS, and add a TURN server for more reliable voice connections across strict networks.
