# Holograms Against Humanity

A terrible game for terrible people: a synced multiplayer Cards Against Humanity clone for up to 10 players. Everything runs in the browser, so it needs only static hosting. Made for **SideQuest / AltspaceVR** worlds, and it also works in **Banter**.

There is no server: players stay in sync through the space's shared state, and the game is plain static files served from <https://hah.firer.at>.

To try it, open <https://hah.firer.at> in Altspace or Banter.

## Features

- More than 70 official and unofficial packs, chosen by the host in game
- Players can rejoin a game in progress and keep their seat

## Add it to an Altspace world (snippet)

In a Creator SDK world, add an empty GameObject at the origin, click **Add Component > BS > Snippet** and type `hah`. Or paste this into `Assets/WebRoot/index.html`, between the snippet section comments:

```html
<!-- snippet section -->
<bs-snippet name="hah" title="Holograms Against Humanity"
  description="Synced multiplayer party card game table."
  script="https://hah.firer.at/snippet.js"
  room=""
  position="0 0 3"
  rotation="0 0 0"
  sound-volume="0.4"
  sound-near="2.5"
  sound-far="10"
  debug="false">
  <bs-gizmo type="position" attribute="position"/>
  <bs-gizmo type="plane" attribute="position" size="3.2 3.2" rotation="90 0 0"/>
</bs-snippet>
<!-- end snippet section -->
```

- Each placement is its own game. Its sync id is `room`, or the placement's own id when `room` is empty. Give placements the same `room` to share one game.
- `position` and `rotation` are Unity world values. The other settings are listed under [Settings](#settings). An empty setting uses the default.
- The Scene-view gizmo shows the table footprint.
- Unity reads the snippet section as XML: quote every attribute, close every element, and write `&` as `&amp;`.

## Add it with a script tag

This works in an Altspace world's `Assets/WebRoot/index.html` (outside the snippet section) and in a Banter space's HTML:

```html
<script src="https://hah.firer.at/hah.js" position="0 -0.4 -5" instance="my-private-game"></script>
```

For more than one table in a space, give each one its own `instance`:

```html
<script src="https://hah.firer.at/hah.js" instance="table1" position="-4 0 0"></script>
<script src="https://hah.firer.at/hah.js" instance="table2" position="4 0 0"></script>
```

## Settings

| Setting | Also accepted | Default | Description |
| :--- | :--- | :--- | :--- |
| `instance` |  | `hah_game` | Sync id. Tables with the same id share one game. In a snippet, use `room` instead. |
| `sound-volume` |  | `0.4` | Volume of the sound effects, from `0` to `1`, heard at full strength near the table. `0` turns them off. |
| `sound-near` |  | `2.5` | Distance in metres from the table within which the sounds play at full volume. |
| `sound-far` |  | `10` | Distance in metres at which the sounds have faded out completely, so people elsewhere in the world aren't disturbed. |
| `position` |  | `0 0 0` | Table position (x y z). |
| `rotation` |  | `0 0 0` | Table rotation in degrees (x y z). |
| `debug` |  | `false` | `true` logs extra detail to the console. |

## How to play

The game starts with the CAH Base Set. The host (or anyone who claims host in an empty room) can change it:

1. Click **DECK OPTIONS** on the centre hub.
2. Click packs to turn them on or off (green is on).
3. Click **SAVE DECKS**.
4. Click **START ROUND**.

## Files

- `hah.js`: the game.
- `decks/cah-all-compact.json`: the cards.
- `Assets/`: sounds and models.
- `formatter.html`: a tool for building deck files.
- `snippet.js`, `snippet.html`: the Creator SDK snippet and its definition.
- `index.html`: a test page with a floor and the game.

## Credits

- Adapted for AltspaceVR by Derogatory, falkrons, schmidtec
- Ported to Banter by Shane; improved and ported from Glitch by FireRat
- Card data: [JSON Against Humanity](https://github.com/FireRat666/Json-Against-Humanity)

See [ATTRIBUTION.txt](ATTRIBUTION.txt).

## License

CC BY-NC-SA 4.0. See [LICENSE](LICENSE).
