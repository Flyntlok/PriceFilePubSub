import { RowDataPacket, createPool } from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_SCHEMA = process.env.DB_SCHEMA || 'price_file_consumption';
const DB_USER = process.env.DB_USER || 'myuser';
const DB_PASS = process.env.DB_PASS || 'myuser';

const pool = createPool({
  database: DB_SCHEMA,
  host: DB_HOST,
  password: DB_PASS,
  user: DB_USER,
  connectionLimit: 20,
  multipleStatements: true,
  dateStrings: true,
  supportBigNumbers: true,
});

let continueProcess = true;

process.on('SIGTERM', () => {
  console.log(
    'SIGTERM received. Finishing remaining processing and terminating'
  );
  continueProcess = false;
});

async function main() {
  do {
    await Promise.all([
      // handleBroadcast(),
      handleConsume(),
    ]);
    // await sleep(600);
    process.exit(0);
  } while (continueProcess);

  process.exit(0);
}

async function handleBroadcast() {
  const mysqlConn = await pool.getConnection();
  try {
    // select from topic table
    const [res] = await mysqlConn.query(
      ` SELECT * from price_file_consumption.topic limit 1;
      `
    );

    if (res[0]) {
      const result = res[0];
      const id = result.id;
      const topic_name = result.topic_name;
      const event_name = result.event_name;
      const payload = result.payload;

      // check subscriber
      const [subscriber] = await mysqlConn.query(
        ` SELECT *
          FROM price_file_consumption.topic_subscription_map
          WHERE topic_name= ?;
        `,
        [topic_name]
      );

      const tables = Object.values(subscriber).map((x) => x.subscription_name);

      // insert into subscriber
      if (tables) {
        for (let i = 0; i < tables.length; i += 1) {
          const jsonValue = Object.keys(payload)
            .flatMap((x) => {
              return [`'${x}'`, `'${payload[x]}'`];
            })
            .join(',');

          await mysqlConn.query(
            ` INSERT INTO ${tables[i]} (msg_id, subscription_name, event_name, payload)
              VALUES (?, ?, ?, json_object(${jsonValue}));
            `,
            [id, topic_name, event_name]
          );
        }
      }

      // remove from topic table.
      await mysqlConn.query(
        ` DELETE FROM price_file_consumption.topic
          WHERE id=?;
        `,
        [id]
      );
    } else {
      console.log('no record found in item master');
    }
    await mysqlConn.release();
  } catch (err) {
    console.log('Broadcast price file updating error.', err);
  }
}

async function handleConsume() {
  const mysqlConn = await pool.getConnection();
  try {
    const subscriptionName = 'Item Genome Event';
    const [res] = await mysqlConn.query(
      ` CALL price_file_consumption.Pubsub_Receive_Subscription_Message(?);
      `,
      [subscriptionName]
    );

    const msgId = res[0][0]['@msg_id'];
    console.log('msgId: ', msgId);

    if (msgId) {
      const item_no = res[0][0]['@item_no'].replace(/"/g, '');
      const distributor_id = parseInt(
        res[0][0]['@distributor_id'].replace(/"/g, '')
      );
      const manufacturer_id = parseInt(
        res[0][0]['@manufacturer_id'].replace(/"/g, '')
      );
      console.log('item_no: ', item_no);
      console.log('distributor_id: ', distributor_id);
      console.log('manufacturer_id: ', manufacturer_id);
      /* 1. select items from different tenants that need to be udpated by this msg
        conditions:
          a. genome_lock(toggled by tenant) = 0
          b. item_active = 1, item need to be active
          c. core < 2 ?
      */
      const [vendorRows] = await mysqlConn.query<VendorRows[]>(
        ` select im.id, pm.tenant_id as tenant_id, im.division_id, im.department_id, im.vendor_id, pm.default_markup, im.unit_sell, im.unit_buy, im.item_cost as master_cost, im.item_list as master_list
          from prod.item_master as im
          join prod.p3_make as pm
          on im.vendor_id=pm.id
          where pm.distributor_id = ?
          and manufacturer_id = ?
          and item_no = ?
          and im.genome_lock = 0
          and im.item_active = 1
          and im.core < 2
        `,
        [distributor_id, manufacturer_id, item_no]
      );

      if (vendorRows) {
        for (const row of vendorRows) {
          const item_id = row.id;
          const tenant_id = row.tenant_id;
          const vendor_id = row.vendor_id;
          const division_id = row.division_id;
          const department_id = row.department_id;
          const default_markup = row.default_markup;
          const unit_sell = row.unit_sell;
          const unit_buy = row.unit_buy;
          const master_cost = row.master_cost;
          const master_list = row.master_list;

          console.log('item_id: ', item_id);
          console.log('tenant_id: ', tenant_id);
          console.log('vendor_id: ', vendor_id);
          console.log('division_id: ', division_id);
          console.log('department_id: ', department_id);
          console.log('default_markup: ', default_markup);
          console.log('unit_sell: ', unit_sell);
          console.log('unit_buy: ', unit_buy);
          console.log('master_cost: ', master_cost);
          console.log('master_list: ', master_list);

          // 2. prepare data
          // get tenant pricing group ids
          const [[priceGroupIds]] = await mysqlConn.query<PriceGrpupIds[]>(
            ` CALL price_file_consumption.Get_Tenant_Pricing_Group_IDs_v2(?, ?);
            `,
            [tenant_id, distributor_id]
          );

          console.log('priceGroupIds: ', priceGroupIds);
          const priceGroupResult =
            priceGroupIds && priceGroupIds[0] && priceGroupIds[0].result;
          const listGroupIds = priceGroupResult && priceGroupResult.list;
          const costGroupIds = priceGroupResult && priceGroupResult.cost;

          /* we didn't update item_master description in current item_master_update_from_genome sproc.
          // get item_genome data
          const [[itemGenomeData]] = await mysqlConn.query<ItemGenomeData[]>(
            ` CALL price_file_consumption.Get_Item_Genome_Data(?, ?);
            `,
            [item_no, manufacturer_id]
          );

          console.log('itemGenomeData: ', itemGenomeData);
          const genoemResult =
            itemGenomeData && itemGenomeData[0] && itemGenomeData[0].result;
          const description = genoemResult && genoemResult.description;
          */

          // get distributor_cost price
          const [[costPricings]] = await mysqlConn.query<CostPricingData[]>(
            ` CALL price_file_consumption.Get_Distributor_Cost_Pricing(?, ?, ?);
            `,
            [item_no, manufacturer_id, distributor_id]
          );

          console.log('costPricings: ', costPricings);
          const costResult =
            costPricings && costPricings[0] && costPricings[0].result;
          const costIds = costResult && costResult.costIds;
          const costPrices = costResult && costResult.costPrices;

          // get distributor_list price from genome
          const [[listPricings]] = await mysqlConn.query<ListPricingData[]>(
            ` CALL price_file_consumption.Get_Distributor_List_Pricing(?, ?, ?);
            `,
            [item_no, manufacturer_id, distributor_id]
          );

          console.log('listPricings: ', listPricings);
          const listResult =
            listPricings && listPricings[0] && listPricings[0].result;
          const listIds = listResult && listResult.listIds;
          const listPrices = listResult && listResult.listPrices;

          // compare and pick the right cost/list price from genome
          const costIdsArray = costIds && costIds.split(',');
          const costPricesArray = costPrices && costPrices.split(',');
          const costGroupIdsArray = costGroupIds && costGroupIds.split(',');
          let currentCost = 0;
          let currentList = 0;
          costIdsArray.forEach((id, index) => {
            const cost = costPricesArray[index];
            costGroupIdsArray.forEach((groupId) => {
              if (groupId == id) {
                currentCost = cost;
              }
            });
          });

          const listIdsArray = listIds && listIds.split(',');
          const listPricesArray = listPrices && listPrices.split(',');
          const listGroupIdsArray = listGroupIds && listGroupIds.split(',');
          listIdsArray.forEach((id, index) => {
            const list = listPricesArray[index];
            listGroupIdsArray.forEach((groupId) => {
              if (groupId == id) {
                currentList = list;
              }
            });
          });

          /* 3. update item_master / update item inventory
            business logic:
            a. use function prod.item_master_variable_cost to get adjusted item_cost, this value is needed for step b.
            b. if the tenant is in item_matrix_v2_tanant table, get adjusted item_list value by sproc: item_variable_markup
              if the tenant is not in item_matrix_v2_tanant table, get adjusted item_list value by sproc: item_master_variable_markup.
            c. use function prod.item_master_variable_msrp to get adjusted item_msrp.
            d. Greenthumb doesn't want their cost to be updated by genome.
            e. master_genome_unit_radio = unit_sele_number(1 if null) / unit_buy_number(1 if null)
            f. final item_list and item_cost returned by step b and c's funcitons should * master_genome_unit_radio
          */
          const [[thepPriceResult]] = await mysqlConn.query<PricingData[]>(
            ` CALL price_file_consumption.Get_Adjusted_Price(?,?,?,?,?,?,?,?,?,?,?);
            `,
            [
              tenant_id,
              vendor_id,
              department_id,
              division_id,
              default_markup,
              unit_buy,
              unit_sell,
              master_cost,
              master_list,
              currentCost,
              currentList,
            ]
          );

          const adjustedPrice = thepPriceResult && thepPriceResult[0];
          const adjustedList = adjustedPrice && adjustedPrice.item_list;
          const adjustedMsrp = adjustedPrice && adjustedPrice.item_msrp;
          const adjustedCost = adjustedPrice && adjustedPrice.item_cost;

          console.log(adjustedMsrp);
          console.log(adjustedList);
          console.log(adjustedCost);

          await mysqlConn.query(
            ` UPDATE prod.item_master
              SET item_list= round(?, 2), item_msrp = round(?, 2), item_cost = round(?, 2), lastUpdated = now()
              WHERE id= ?
            `,
            [adjustedList, adjustedMsrp, adjustedCost, item_id]
          );
        }
      }

      /*
      await mysqlConn.query(
        ` CALL price_file_consumption.Pubsub_Acknowledge_Item(?);
        `,
        [msgId]
      );
      */
    } else {
      console.log('no data to update.');
    }

    await mysqlConn.release();
  } catch (err) {
    console.log('Consume price file updating error.', err);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

interface VendorRows extends RowDataPacket {
  id: string;
  tenant_id: string;
}

interface PriceGrpupIds extends RowDataPacket {
  tenantListGroupIds: string;
  tenantCostGroupIds: string;
}

interface ItemGenomeData extends RowDataPacket {
  description: string;
}

interface CostPricingData extends RowDataPacket {
  costIds: string;
  costPrices: string;
}

interface PricingData extends RowDataPacket {
  item_cost: string;
  item_list: string;
  item_msrp: string;
}

interface ListPricingData extends RowDataPacket {
  listIds: string;
  listPrices: string;
}
