// Resource system
class ResourceManager {
    constructor(onResourcesChanged = null) {
        this.food = 200;
        this.wood = 200;
        this.stone = 100;
        this.gold = 50;
        this.population = 0;
        this.maxPopulation = 10;
        this.harvestRate = 1.0;
        this.onResourcesChanged = onResourcesChanged;
    }

    hasResources(cost) {
        return this.food >= (cost.food || 0) &&
               this.wood >= (cost.wood || 0) &&
               this.stone >= (cost.stone || 0) &&
               this.gold >= (cost.gold || 0);
    }

    spendResources(cost) {
        this.food -= (cost.food || 0);
        this.wood -= (cost.wood || 0);
        this.stone -= (cost.stone || 0);
        this.gold -= (cost.gold || 0);
        if (this.onResourcesChanged) this.onResourcesChanged();
    }

    addResource(type, amount) {
        switch(type) {
            case 'food': this.food += amount; break;
            case 'wood': this.wood += amount; break;
            case 'stone': this.stone += amount; break;
            case 'gold': this.gold += amount; break;
        }
        // Lifetime total ever DELIVERED, per type — the honest economy curve.
        // A held stockpile measures hoarding: a player converting resources into army
        // and buildings (i.e. playing well) shows a falling balance, and the winner
        // often ends poorest. This only ever rises, so growth is growth.
        // Every gather funnels through here, so one counter catches LLM and
        // rule-based players alike.
        if (!this.gathered) this.gathered = { food: 0, wood: 0, stone: 0, gold: 0 };
        if (this.gathered[type] !== undefined && amount > 0) this.gathered[type] += amount;
        if (this.onResourcesChanged) this.onResourcesChanged();
    }

    getResource(type) {
        switch(type) {
            case 'food': return this.food;
            case 'wood': return this.wood;
            case 'stone': return this.stone;
            case 'gold': return this.gold;
            default: return 0;
        }
    }

    updatePopulation(count) {
        this.population = count;
    }

    canAfford(cost) {
        return this.hasResources(cost);
    }

    updateUI() {
        const tt = (typeof t === 'function') ? t : (k) => k;
        document.getElementById('foodRes').textContent = `${tt('res.food')}: ${Math.floor(this.food)}`;
        document.getElementById('woodRes').textContent = `${tt('res.wood')}: ${Math.floor(this.wood)}`;
        document.getElementById('stoneRes').textContent = `${tt('res.stone')}: ${Math.floor(this.stone)}`;
        document.getElementById('goldRes').textContent = `${tt('res.gold')}: ${Math.floor(this.gold)}`;
        document.getElementById('popRes').textContent = `${tt('res.pop')}: ${this.population}/${this.maxPopulation}`;
    }
}
