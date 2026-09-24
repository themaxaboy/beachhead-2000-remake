// Unit stats (pure data). Armor values multiply the base damage of each weapon class.

export const WEAPON_DAMAGE = {
  mg: { damage: 25 },
  pistol: { damage: 20 },
  at: { damage: 150, splash: 60, splashRadius: 6 },
  missile: { damage: 300, splash: 90, splashRadius: 7 },
  howitzer: { damage: 400, splash: 260, splashRadius: 20 },
};

export const UNITS = {
  infantry: {
    name: 'Infantry',
    hp: 20,
    score: 50,
    force: 1,
    armor: { mg: 1, pistol: 1, at: 1, missile: 1, howitzer: 1 },
    advice: 'Machine gun / handgun',
  },
  lct: {
    name: 'Landing craft',
    hp: 300,
    score: 250,
    force: 3,
    armor: { mg: 0.06, pistol: 0.02, at: 1, missile: 1.1, howitzer: 1 },
    advice: 'Anti-tank gun before it beaches',
  },
  apc: {
    name: 'M113 APC',
    hp: 150,
    score: 400,
    force: 4,
    armor: { mg: 0.1, pistol: 0.02, at: 1, missile: 1, howitzer: 1 },
    advice: 'Anti-tank gun',
  },
  tank: {
    name: 'M48 tank',
    hp: 300,
    score: 500,
    force: 5,
    armor: { mg: 0.01, pistol: 0, at: 1, missile: 1, howitzer: 1 },
    advice: 'Anti-tank gun (2 hits) or missile',
  },
  cobra: {
    name: 'AH-1 Cobra',
    hp: 200,
    score: 750,
    force: 5,
    armor: { mg: 0.4, pistol: 0.2, at: 1.5, missile: 1, howitzer: 1 },
    advice: 'Machine gun or missile',
  },
  ch53: {
    name: 'CH-53 transport',
    hp: 350,
    score: 600,
    force: 4,
    armor: { mg: 0.4, pistol: 0.2, at: 1.5, missile: 1.2, howitzer: 1 },
    advice: 'Machine gun before the drop',
  },
  jet: {
    name: 'F-4 fighter',
    hp: 180,
    score: 1000,
    force: 4,
    armor: { mg: 0.6, pistol: 0.2, at: 1.5, missile: 1, howitzer: 1 },
    advice: 'Missile, or lead it with the machine gun',
  },
  bomber: {
    name: 'B-52 bomber',
    hp: 1500,
    score: 2000,
    force: 0,
    armor: { mg: 0.4, pistol: 0, at: 1, missile: 1, howitzer: 1 },
    advice: 'Optional target — take cover and survive',
  },
};
